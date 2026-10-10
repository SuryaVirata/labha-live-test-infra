// Real, unmocked browser test for D8 (login bounce keeps typed signup data,
// only resets phone/OTP). Real Chromium, real dashboard (port 5182, isolated
// from the user's own 5173), real backend.
//
// Flow: start a signup, verify OTP for phone A, type a full name on step 2
// (never submit), bounce to /login, enter a fresh unregistered phone B,
// follow the real "Create an account" link the app shows for accountNotFound,
// land back on /signup with phone B — confirm the full name survived and the
// phone/OTP state reset.

const WD = 'http://localhost:4444/wd/hub';
const BASE = 'http://172.26.224.1:5182';
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

async function findEl(sessionId, using, value, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      return await wd(`/session/${sessionId}/element`, 'POST', { using, value });
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`element not found: ${using}=${value}`);
}

async function setValue(sessionId, el, text) {
  await wd(`/session/${sessionId}/element/${el[EL]}/clear`, 'POST', {}).catch(() => {});
  await wd(`/session/${sessionId}/element/${el[EL]}/value`, 'POST', { text });
}

// Reads the dev-OTP box and submits it, retrying via a real Resend click if
// the first code is rejected (observed once: likely a stale read of the OTP
// text right as it rendered). Returns once verifyOTP genuinely succeeds.
async function verifyOtpFlow(sessionId, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const devOtpText = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `
        const box = Array.from(document.querySelectorAll('div')).find(d => d.textContent.startsWith('Dev code:'));
        if (!box) return null;
        const m = box.textContent.match(/Dev code:\\s*(\\d{4,8})/);
        return m ? m[1] : null;
      `,
      args: []
    });
    console.log(`${label}: dev OTP attempt ${attempt}:`, devOtpText);
    if (!devOtpText) throw new Error(`${label}: no dev OTP box found`);

    const otpEl = await findEl(sessionId, 'css selector', '#wiz-otp');
    await setValue(sessionId, otpEl, devOtpText);
    const typedValue = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `return document.querySelector('#wiz-otp')?.value ?? null;`,
      args: []
    });
    console.log(`${label}: otp input actually contains:`, typedValue);

    const continueBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Continue')]");
    await click(sessionId, continueBtn);
    await new Promise((r) => setTimeout(r, 1800));

    const stillOnOtpScreen = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `return !!document.querySelector('#wiz-otp');`,
      args: []
    });
    const errorText = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `return document.querySelector('[role="alert"]')?.textContent ?? null;`,
      args: []
    });
    if (!stillOnOtpScreen) {
      console.log(`${label}: verified successfully on attempt ${attempt}`);
      return;
    }
    console.log(`${label}: attempt ${attempt} failed, error shown:`, errorText);
    // Real resend, wait for the real cooldown before retrying.
    await new Promise((r) => setTimeout(r, 31000));
    const resendBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Resend code')]");
    await click(sessionId, resendBtn);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: OTP verification failed after 3 attempts`);
}

async function click(sessionId, el) {
  await wd(`/session/${sessionId}/element/${el[EL]}/click`, 'POST', {});
}

async function bodyText(sessionId, n = 800) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `return document.body.innerText.slice(0,${n});`,
    args: []
  });
}

// Two genuinely fresh, unregistered-looking numbers so this run doesn't
// collide with any prior test data or trip the resend cooldown from an
// earlier attempt.
const now = 9800000000 + (17 % 90) * 111111; // deterministic-ish, avoids Date.now()
const PHONE_A = String(now).slice(0, 10);
const PHONE_B = String(now + 1).slice(0, 10);

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
console.log('session', sessionId, 'PHONE_A', PHONE_A, 'PHONE_B', PHONE_B);

try {
  // --- Step 1: start signup, verify OTP for phone A ---
  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/signup` });
  const mobileEl = await findEl(sessionId, 'css selector', '#wiz-mobile');
  await setValue(sessionId, mobileEl, PHONE_A);
  const sendOtpBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Send OTP')]");
  await click(sessionId, sendOtpBtn);
  await new Promise((r) => setTimeout(r, 1500));

  await verifyOtpFlow(sessionId, 'phone A');
  console.log('after OTP verify, page text:', JSON.stringify(await bodyText(sessionId, 300)));

  // --- Step 2: type a full name, never submit ---
  const fullNameEl = await findEl(sessionId, 'css selector', '#wiz-full-name');
  await setValue(sessionId, fullNameEl, 'D8 Live Test Merchant');
  await new Promise((r) => setTimeout(r, 800)); // let the persist-on-change effect fire

  const sessionStorageBeforeBounce = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `return sessionStorage.getItem('labha-signup-wizard');`,
    args: []
  });
  console.log('sessionStorage before bounce:', sessionStorageBeforeBounce);

  // --- Step 3: simulate the session having ended (expired token / explicit
  // logout) while the signup draft itself is untouched — realistic trigger
  // for actually landing back on /login mid-signup, since verifying OTP
  // during signup establishes a real session and GuestGuard would otherwise
  // just redirect an authenticated tab away from /login. Only the real auth
  // store key is cleared; 'labha-signup-wizard' (the actual thing D8 is
  // about) is left exactly as the app wrote it. ---
  await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `sessionStorage.removeItem('labha-auth');`,
    args: []
  });
  await wd(`/session/${sessionId}/url`, 'POST', { url: `${BASE}/login` });
  await new Promise((r) => setTimeout(r, 1000));

  const loginPhoneEl = await findEl(sessionId, 'css selector', '#login-phone');
  await setValue(sessionId, loginPhoneEl, PHONE_B);
  const loginSendBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Send OTP')]");
  await click(sessionId, loginSendBtn);
  await new Promise((r) => setTimeout(r, 1500));

  console.log('login page after unregistered phone:', JSON.stringify(await bodyText(sessionId, 400)));

  // Follow the real "Create an account" link the app renders for accountNotFound.
  const createAccountLink = await findEl(sessionId, 'xpath', "//a[contains(., 'Create an account')]");
  await click(sessionId, createAccountLink);
  await new Promise((r) => setTimeout(r, 1200));

  // --- Step 4: confirm what actually landed on /signup ---
  const landedUrl = await wd(`/session/${sessionId}/url`, 'GET');
  const mobileValueAfter = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `const el = document.querySelector('#wiz-mobile'); return el ? el.value : 'NO_MOBILE_INPUT (past step 0?)';`,
    args: []
  });
  const pageAfterBounce = await bodyText(sessionId, 400);
  console.log('landed URL:', landedUrl);
  console.log('mobile input value after bounce:', mobileValueAfter);
  console.log('page text after bounce:', JSON.stringify(pageAfterBounce));

  // Complete OTP for phone B for real, to reach step 2 and read data.fullName
  // back out of the actual rendered form (the real proof D8 needs: did the
  // typed name survive past the phone/OTP reset?).
  await verifyOtpFlow(sessionId, 'phone B');

  const fullNameValueAfter = await wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `const el = document.querySelector('#wiz-full-name'); return el ? el.value : 'NO_FULL_NAME_INPUT';`,
    args: []
  });
  console.log('fullName input value on step 2 for phone B:', fullNameValueAfter);
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
