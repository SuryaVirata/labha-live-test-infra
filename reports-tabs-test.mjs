// Real, unmocked browser test of the Reports page date-range tabs
// (Today / Yesterday / 7 days / 30 days / This month / Last month).
// Drives real Chromium against the real dashboard dev server and the real
// running backend — no mocks anywhere in this chain.

const WD = 'http://localhost:4444/wd/hub';
const BASE = 'http://172.26.224.1:5173';

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

const EL = 'element-6066-11e4-a52e-4f735466cecf';

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

async function click(sessionId, using, value) {
  const el = await findEl(sessionId, using, value);
  await wd(`/session/${sessionId}/element/${el[EL]}/click`, 'POST', {});
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
  // --- Real login, as a real merchant owner ---
  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/login` });
  await click(sessionId, 'xpath', "//button[contains(., 'Platform admin')]");
  const emailEl = await findEl(sessionId, 'css selector', '#admin-email');
  await wd(`/session/${sessionId}/element/${emailEl[EL]}/value`, 'POST', { text: 'owner@labha.dev' });
  const passEl = await findEl(sessionId, 'css selector', '#admin-password');
  await wd(`/session/${sessionId}/element/${passEl[EL]}/value`, 'POST', { text: 'Labha123!' });
  await click(sessionId, 'xpath', "//button[contains(., 'Sign in')]");
  await new Promise((r) => setTimeout(r, 2000));

  const postLoginUrl = await wd(`/session/${sessionId}/url`);
  console.log('post-login URL:', postLoginUrl);

  // --- Pick the store (SelectStorePage lists stores as buttons) ---
  if (postLoginUrl.includes('/select-store')) {
    await click(sessionId, 'css selector', 'div.space-y-2 > button');
    await new Promise((r) => setTimeout(r, 1500));
  }
  const postSelectUrl = await wd(`/session/${sessionId}/url`);
  console.log('post-store-select URL:', postSelectUrl);

  // --- Navigate to that store's Reports/Analytics page ---
  const slugMatch = postSelectUrl.match(/\/store\/([^/]+)\//);
  const analyticsUrl = slugMatch ? `${BASE}/store/${slugMatch[1]}/analytics` : `${BASE}/analytics`;
  await wd(`/session/${sessionId}/url`, 'POST', { url: analyticsUrl });
  await new Promise((r) => setTimeout(r, 2000));

  const pageText = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText.slice(0, 500);',
    args: []
  });
  console.log('page text after nav to /analytics:', JSON.stringify(pageText));

  // --- Confirm all 6 tabs are present, read which is active by default ---
  const tabState = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      const btns = Array.from(document.querySelectorAll('button')).filter(b =>
        ['Today','Yesterday','7 days','30 days','This month','Last month'].includes(b.textContent.trim())
      );
      return btns.map(b => ({ label: b.textContent.trim(), active: b.className.includes('bg-brand-600') }));
    `,
    args: []
  });
  console.log('tabs found, default active state:', JSON.stringify(tabState));

  // --- Dismiss the real onboarding welcome modal if it's covering the tabs ---
  const dismissed = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `
      const dialog = document.querySelector('div[role="dialog"][aria-labelledby="onboarding-welcome-heading"]');
      if (!dialog) return 'no-dialog';
      const buttons = dialog.querySelectorAll('button');
      const secondary = buttons[1] || buttons[0];
      if (!secondary) return 'no-button';
      secondary.click();
      return 'clicked:' + secondary.textContent.trim();
    `,
    args: []
  });
  console.log('onboarding modal dismiss attempt:', dismissed);
  await new Promise((r) => setTimeout(r, 800));

  // --- Click through every tab, checking it becomes active and no error appears ---
  const labels = ['Today', 'Yesterday', '7 days', '30 days', 'This month', 'Last month'];
  const results = [];
  for (const label of labels) {
    await click(sessionId, 'xpath', `//button[normalize-space(text())='${label}']`);
    await new Promise((r) => setTimeout(r, 1200));
    const state = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `
        const btns = Array.from(document.querySelectorAll('button')).filter(b =>
          ['Today','Yesterday','7 days','30 days','This month','Last month'].includes(b.textContent.trim())
        );
        const clicked = btns.find(b => b.textContent.trim() === ${JSON.stringify(label)});
        const bodyText = document.body.innerText;
        const hasError = /something went wrong|failed to load|error loading/i.test(bodyText);
        return { isActive: clicked ? clicked.className.includes('bg-brand-600') : null, hasError };
      `,
      args: []
    });
    results.push({ label, ...state });
    console.log(`clicked "${label}" ->`, JSON.stringify(state));
  }

  console.log('\n=== VERDICT ===');
  const allActivated = results.every((r) => r.isActive === true);
  const noErrors = results.every((r) => r.hasError === false);
  console.log(`Every tab became active when clicked: ${allActivated ? 'PASS' : 'FAIL'}`);
  console.log(`No error state appeared on any tab: ${noErrors ? 'PASS' : 'FAIL'}`);
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
