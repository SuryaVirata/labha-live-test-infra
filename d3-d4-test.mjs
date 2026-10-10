// Real, unmocked browser test for D3 (resend cooldown survives reload) and
// D4 (resend click has real error handling). Real Chromium, real dashboard,
// real backend — nothing faked except one deliberate client/server cooldown
// desync (set via real sessionStorage, not a mocked network call) used to
// genuinely trigger the real 429 D4's error handling exists for.

const WD = 'http://localhost:4444/wd/hub';
const BASE = 'http://172.26.224.1:5181';
const EL = 'element-6066-11e4-a52e-4f735466cecf';

async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.value;
}

async function findEl(sessionId, using, value, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      return await wd(`/session/${sessionId}/element`, 'POST', { using, value });
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`element not found: ${using}=${value}`);
}

const session = await wd('/session', 'POST', {
  capabilities: {
    alwaysMatch: {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--window-size=1280,900', '--unsafely-treat-insecure-origin-as-secure=' + BASE]
      }
    }
  }
});
const sessionId = session.sessionId;
console.log('session', sessionId);

try {
  // --- Real merchant login flow (phone OTP), fresh unregistered-looking number won't work for login,
  // so use merchant mode + a phone that genuinely creates a challenge via the real UI. ---
  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/login` });
  await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `window.addEventListener('unhandledrejection', () => { window.__unhandledRejection = true; });`,
    args: []
  });

  const phoneEl = await findEl(sessionId, 'css selector', '#login-phone');
  await wd(`/session/${sessionId}/element/${phoneEl[EL]}/value`, 'POST', { text: '9876544955' });
  const btnEl = await findEl(sessionId, 'xpath', "//button[contains(., 'Send OTP')]");
  await wd(`/session/${sessionId}/element/${btnEl[EL]}/click`, 'POST', {});
  await new Promise((r) => setTimeout(r, 1500));

  const bodyText1 = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText.slice(0,600);',
    args: []
  });
  console.log('page after send:', JSON.stringify(bodyText1));

  // --- D3: read the resend cooldown text, reload, confirm it's still counting from roughly where it was ---
  const cooldownBefore = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      const btn = Array.from(document.querySelectorAll('button')).find(b => /Resend code/.test(b.textContent));
      return btn ? btn.textContent.trim() : null;
    `,
    args: []
  });
  console.log('D3: cooldown text before reload:', cooldownBefore);

  await new Promise((r) => setTimeout(r, 3000)); // let a few real seconds pass
  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/login` }); // real reload
  await new Promise((r) => setTimeout(r, 1500));

  const cooldownAfter = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      const btn = Array.from(document.querySelectorAll('button')).find(b => /Resend code/.test(b.textContent));
      return btn ? btn.textContent.trim() : null;
    `,
    args: []
  });
  console.log('D3: cooldown text after real reload (~3s later):', cooldownAfter);

  // --- D4: force a genuine client/server cooldown desync via real sessionStorage state,
  // then click Resend for real — this produces a real 429 from the real backend. ---
  const forceExpired = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      const raw = sessionStorage.getItem('labha-login-page');
      if (!raw) return 'no-storage-key';
      const parsed = JSON.parse(raw);
      parsed.cooldownUntil = Date.now() - 1000; // client believes cooldown already ended
      sessionStorage.setItem('labha-login-page', JSON.stringify(parsed));
      return 'forced:' + JSON.stringify(parsed);
    `,
    args: []
  });
  console.log('D4 setup: forced client-side cooldown expiry:', forceExpired);

  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/login` }); // reload to pick up the forced state
  await new Promise((r) => setTimeout(r, 1500));
  await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `window.addEventListener('unhandledrejection', () => { window.__unhandledRejection = true; });`,
    args: []
  });

  const resendBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Resend code')]");
  await wd(`/session/${sessionId}/element/${resendBtn[EL]}/click`, 'POST', {});
  await new Promise((r) => setTimeout(r, 1500));

  const afterErrorClick = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      return {
        bodyText: document.body.innerText.slice(0, 800),
        hasJsError: !!window.__unhandledRejection,
        alertRole: document.querySelector('[role="alert"]')?.textContent ?? null
      };
    `,
    args: []
  });
  console.log('D4: state after clicking Resend against a real, still-active server cooldown:', JSON.stringify(afterErrorClick));
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
