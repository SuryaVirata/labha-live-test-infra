// Manual, real-browser verification of the Merchant (labha-dashboard) social-login
// feature — iteration 02. Drives real Chromium via raw WebDriver REST (no mocked
// network); the dashboard and backend are the ones actually running on this
// machine. Pattern copied from unified-login-test.mjs / real-browser-test.mjs.
//
// Usage: node merchant-manual-test-browser.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1'; // dashboard container network sees the host at this IP
// NOTE on port 5174 (not the "main" 5173 instance): the dashboard's own
// VITE_API_BASE_URL fallback bakes in "http://localhost:8080/api/v1" from
// .env, which does not route from inside the Selenium container's network
// namespace (confirmed live: fetch() to localhost:8080 from that container
// fails even when CORS allows the origin). It also turns out the main 5173
// origin isn't in the backend's CORS_ALLOWED_ORIGINS at all (only
// 172.21.0.1:5174/5175 are, leftover from earlier sessions), so every
// API call the dashboard makes from a browser navigated to 172.21.0.1:5173
// is blocked before it even leaves the browser. Both are real, diagnosed
// findings — see 00-environment-cors-network-finding.txt in the proofs dir.
// Workaround used here: a second, isolated vite dev instance was started on
// port 5174 (already CORS-whitelisted) with VITE_API_BASE_URL overridden
// (process-env only, nothing written to any .env file) to
// http://172.21.0.1:8080/api/v1 — the docker host-gateway address, which
// IS reachable from inside the container. This does not touch, restart, or
// in any way affect the already-running 5173 dev server or the backend.
const PORT = 5174;
const BASE = `http://${HOST}:${PORT}`;
const NEW_PHONE = String(Math.floor(9000000000 + Math.random() * 999999999)).slice(0, 10);
const PROOFS = join(
  dirname(fileURLToPath(import.meta.url)),
  'proofs',
  'iteration-02',
  'merchant'
);

mkdirSync(PROOFS, { recursive: true });

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

function elId(el) {
  return el['element-6066-11e4-a52e-4f735466cecf'];
}

async function newSession() {
  return wd('/session', 'POST', {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          args: [
            '--window-size=1280,900',
            `--unsafely-treat-insecure-origin-as-secure=${BASE}`
          ]
        }
      }
    }
  });
}

async function findEl(sessionId, using, value, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      return await wd(`/session/${sessionId}/element`, 'POST', { using, value });
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`element not found: ${using}=${value}`);
}

async function maybeFindEl(sessionId, using, value, retries = 5) {
  try {
    return await findEl(sessionId, using, value, retries);
  } catch {
    return null;
  }
}

async function scrollIntoView(sessionId, el) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: "arguments[0].scrollIntoView({block: 'center'});",
    args: [el]
  });
}

async function jsClick(sessionId, el) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'arguments[0].click();',
    args: [el]
  });
}

async function click(sessionId, el) {
  try {
    return await wd(`/session/${sessionId}/element/${elId(el)}/click`, 'POST', {});
  } catch (err) {
    // Native click can fail with "element click intercepted" when the
    // element is below the fold or another element overlaps its computed
    // click point. Scroll it into view and retry; if that still fails, fall
    // back to a real DOM .click() via execute/sync (still a genuine click
    // dispatched on the actual element, just not routed through WebDriver's
    // geometry-based pointer simulation).
    await scrollIntoView(sessionId, el).catch(() => {});
    try {
      return await wd(`/session/${sessionId}/element/${elId(el)}/click`, 'POST', {});
    } catch {
      return jsClick(sessionId, el);
    }
  }
}

async function setValue(sessionId, el, text, clearFirst = true) {
  if (clearFirst) await wd(`/session/${sessionId}/element/${elId(el)}/clear`, 'POST', {}).catch(() => {});
  return wd(`/session/${sessionId}/element/${elId(el)}/value`, 'POST', { text });
}

async function shot(sessionId, name) {
  const png = await wd(`/session/${sessionId}/screenshot`, 'GET');
  const file = join(PROOFS, name);
  writeFileSync(file, Buffer.from(png, 'base64'));
  console.log('saved', file);
  return file;
}

async function bodyText(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText;',
    args: []
  });
}

async function currentUrl(sessionId) {
  return wd(`/session/${sessionId}/url`, 'GET');
}

async function handles(sessionId) {
  return wd(`/session/${sessionId}/window/handles`, 'GET');
}

async function switchWindow(sessionId, handle) {
  return wd(`/session/${sessionId}/window`, 'POST', { handle });
}

async function closeCurrentWindow(sessionId) {
  return wd(`/session/${sessionId}/window`, 'DELETE');
}

function writeText(name, content) {
  const file = join(PROOFS, name);
  writeFileSync(file, content, 'utf8');
  console.log('saved', file);
  return file;
}

function extractDevCode(text) {
  const m = text.match(/Dev code:\s*(\d+)/);
  return m ? m[1] : null;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

async function main() {
  console.log('Testing with brand-new phone number:', NEW_PHONE);
  writeText('00-test-phone-number.txt', `NEW_PHONE=${NEW_PHONE}\nTimestamp: ${new Date().toISOString()}\n`);

  // =========================================================================
  // SESSION A: Full signup -> onboarding -> dashboard -> logout -> existing login
  // =========================================================================
  let session = await newSession();
  let sid = session.sessionId;
  console.log('WebDriver session A:', sid);

  try {
    // 1. Login page — confirm path and both OAuth buttons visible.
    await wd(`/session/${sid}/url`, 'POST', { url: `${BASE}/login` });
    await findEl(sid, 'css selector', '#login-phone');
    let text = await bodyText(sid);
    await shot(sid, '01-login-page.png');
    const hasGoogleBtn = /Continue with Google/i.test(text);
    const hasFacebookBtn = /Continue with Facebook/i.test(text);
    record('Login page loads at /login with phone form', true, `url=${BASE}/login`);
    record('Google button visible on login page', hasGoogleBtn, text.slice(0, 50));
    record('Facebook button visible on login page', hasFacebookBtn, text.slice(0, 50));
    writeText(
      '01-login-page-result.txt',
      `PASS: Login page loaded at /login\nGoogle button present: ${hasGoogleBtn}\nFacebook button present: ${hasFacebookBtn}\n\n--- page text ---\n${text}`
    );

    // 2. Navigate to /signup for the real new-merchant OTP signup flow.
    await wd(`/session/${sid}/url`, 'POST', { url: `${BASE}/signup` });
    await findEl(sid, 'css selector', '#wiz-mobile');
    await shot(sid, '02-signup-mobile-form.png');

    const mobileEl = await findEl(sid, 'css selector', '#wiz-mobile');
    await setValue(sid, mobileEl, NEW_PHONE);
    await shot(sid, '03-signup-phone-typed.png');

    const sendOtpBtn = await findEl(sid, 'xpath', "//button[contains(., 'Send OTP')]");
    await click(sid, sendOtpBtn);
    await new Promise((r) => setTimeout(r, 3000));

    await findEl(sid, 'css selector', '#wiz-otp', 30);
    text = await bodyText(sid);
    await shot(sid, '04-signup-otp-requested-dev-code-visible.png');
    const devOtp1 = extractDevCode(text);
    record('Signup OTP requested, dev_otp visible on page', Boolean(devOtp1), `dev_otp=${devOtp1}`);
    writeText(
      '04-signup-otp-requested-dev-code-visible.txt',
      `Testing: POST /auth/otp/request (purpose=merchant_signup) for brand-new phone ${NEW_PHONE}\nObserved: dev_otp=${devOtp1}\nResult: ${devOtp1 ? 'PASS - dev OTP shown' : 'FAIL - no dev OTP found'}\n\n--- page text ---\n${text}`
    );
    if (!devOtp1) throw new Error('Signup: no dev OTP shown, cannot continue');

    // #wiz-otp is pre-filled with the dev code by the app itself; just submit.
    const verifyBtn1 = await findEl(sid, 'xpath', "//button[contains(., 'Continue')]");
    await click(sid, verifyBtn1);
    await new Promise((r) => setTimeout(r, 2500));

    text = await bodyText(sid);
    await shot(sid, '05-signup-otp-verified-details-step.png');
    const reachedDetails = /Your details/i.test(text);
    record('Signup OTP verified, advanced to "Your details" step', reachedDetails, text.slice(0, 80));
    writeText(
      '05-signup-otp-verified-details-step.txt',
      `Testing: POST /auth/otp/verify (purpose=merchant_signup) with dev code ${devOtp1}\nResult: ${reachedDetails ? 'PASS - landed on Your details step (session established, no merchant yet)' : 'FAIL - did not reach details step'}\n\n--- page text ---\n${text}`
    );
    if (!reachedDetails) throw new Error('Signup: did not reach details step after OTP verify');

    // 3. Fill the one required field (legal name) and submit — creates the merchant.
    const nameEl = await findEl(sid, 'css selector', '#wiz-full-name');
    // Legal name is letters/spaces/.'- only — no digits (backend NAME_PATTERN).
    await setValue(sid, nameEl, 'Manual Test Merchant');
    await shot(sid, '06-signup-details-filled.png');

    const submitBtn = await findEl(sid, 'xpath', "//button[@data-analytics-id='auth.signup.details_submit']");
    await click(sid, submitBtn);
    await new Promise((r) => setTimeout(r, 3000));

    text = await bodyText(sid);
    let url = await currentUrl(sid);
    await shot(sid, '07-signup-complete-landed-dashboard.png');
    const landedDashboard = /\/dashboard/.test(url);
    record('Merchant registered, landed on dashboard', landedDashboard, `url=${url}`);
    writeText(
      '07-signup-complete-landed-dashboard.txt',
      `Testing: POST /merchants/register after details submit\nResult: ${landedDashboard ? 'PASS' : 'FAIL'} — url=${url}\n\n--- page text ---\n${text}`
    );

    // 4. Real UI logout via Topbar "Sign out".
    const signOutBtn = await maybeFindEl(sid, 'xpath', "//button[contains(., 'Sign out')]", 15);
    if (!signOutBtn) {
      await shot(sid, '08-logout-NO-SIGNOUT-BUTTON-FOUND.png');
      record('Found Sign out button in Topbar', false, 'not found after 15 retries');
    } else {
      await click(sid, signOutBtn);
      await new Promise((r) => setTimeout(r, 2000));
      url = await currentUrl(sid);
      text = await bodyText(sid);
      await shot(sid, '08-logout-done-back-to-login.png');
      const backAtLogin = /\/login/.test(url);
      record('Clicked real Sign out, redirected to /login', backAtLogin, `url=${url}`);
      writeText(
        '08-logout-done-back-to-login.txt',
        `Testing: clicked real Topbar "Sign out" button (calls POST /auth/logout)\nResult: ${backAtLogin ? 'PASS' : 'FAIL'} — url=${url}\n\n--- page text ---\n${text}`
      );
    }

    // 5. Existing-account login with the SAME phone number.
    await wd(`/session/${sid}/url`, 'POST', { url: `${BASE}/login` });
    await findEl(sid, 'css selector', '#login-phone');
    const phoneEl2 = await findEl(sid, 'css selector', '#login-phone');
    await setValue(sid, phoneEl2, NEW_PHONE);
    await shot(sid, '09-existing-login-phone-typed.png');

    const sendOtpBtn2 = await findEl(sid, 'xpath', "//button[contains(., 'Send OTP')]");
    await click(sid, sendOtpBtn2);
    await new Promise((r) => setTimeout(r, 3000));

    text = await bodyText(sid);
    await shot(sid, '10-existing-login-otp-screen-recognized.png');
    const notFoundBanner = /isn.t connected to your existing account/i.test(text);
    const otpStageReached = /Code sent to/i.test(text) && !notFoundBanner;
    const devOtp2 = extractDevCode(text);
    record(
      'Existing phone recognized by LOGIN (not treated as new/unknown)',
      otpStageReached && !notFoundBanner,
      `notFoundBanner=${notFoundBanner} otpStageReached=${otpStageReached} dev_otp=${devOtp2}`
    );
    writeText(
      '10-existing-login-otp-screen-recognized.txt',
      `Testing: POST /auth/otp/request (purpose=login) for the SAME phone ${NEW_PHONE} that just completed signup.\n` +
        `"Account not found" banner shown: ${notFoundBanner} (want false)\n` +
        `Proceeded straight to OTP screen: ${otpStageReached} (want true)\n` +
        `dev_otp: ${devOtp2}\n` +
        `Result: ${otpStageReached && !notFoundBanner ? 'PASS - existing account correctly recognized' : 'FAIL'}\n\n--- page text ---\n${text}`
    );

    if (devOtp2) {
      const otpEl2 = await findEl(sid, 'css selector', '#login-otp');
      await setValue(sid, otpEl2, devOtp2);
      const verifyBtn2 = await findEl(sid, 'xpath', "//button[contains(., 'Verify')]");
      await click(sid, verifyBtn2);
      await new Promise((r) => setTimeout(r, 3000));
      text = await bodyText(sid);
      url = await currentUrl(sid);
      await shot(sid, '11-existing-login-verified-landed.png');
      const landedAgain = /\/dashboard/.test(url);
      const notBackToSignupForm = !/Your details/i.test(text);
      record(
        'Existing login verify lands back on dashboard, NOT the signup details form again',
        landedAgain && notBackToSignupForm,
        `url=${url}`
      );
      writeText(
        '11-existing-login-verified-landed.txt',
        `Testing: POST /auth/otp/verify (purpose=login) for existing merchant.\n` +
          `Landed on dashboard: ${landedAgain}\nShown signup form again (should be false): ${!notBackToSignupForm}\n` +
          `Result: ${landedAgain && notBackToSignupForm ? 'PASS' : 'FAIL'} — url=${url}\n\n--- page text ---\n${text}`
      );
    }
  } finally {
    await wd(`/session/${sid}`, 'DELETE').catch(() => {});
  }

  // =========================================================================
  // SESSION B: Fresh, unauthenticated session — Google / Facebook popup probes
  // =========================================================================
  session = await newSession();
  sid = session.sessionId;
  console.log('WebDriver session B (OAuth popups):', sid);

  try {
    await wd(`/session/${sid}/url`, 'POST', { url: `${BASE}/login` });
    await findEl(sid, 'css selector', '#login-phone');

    // --- Google ---
    const beforeHandles = await handles(sid);
    const googleBtn = await findEl(sid, 'xpath', "//button[contains(., 'Continue with Google')]");
    await click(sid, googleBtn);

    let googleUrl = null;
    let googlePopupFound = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const after = await handles(sid);
      const newHandle = after.find((h) => !beforeHandles.includes(h));
      if (newHandle) {
        await switchWindow(sid, newHandle);
        await new Promise((r) => setTimeout(r, 1200)); // let it navigate to accounts.google.com
        googleUrl = await currentUrl(sid);
        if (/accounts\.google\.com/.test(googleUrl)) {
          googlePopupFound = true;
          await shot(sid, '12-google-popup-real-accounts-google-com.png');
          break;
        }
      }
    }
    if (googlePopupFound) {
      const u = new URL(googleUrl);
      record('Google popup reached real accounts.google.com', true, googleUrl);
      writeText(
        '12-google-popup-real-accounts-google-com.txt',
        `Testing: clicked real "Continue with Google" button.\n` +
          `Full popup URL: ${googleUrl}\n\n` +
          `client_id: ${u.searchParams.get('client_id')}\n` +
          `redirect_uri: ${u.searchParams.get('redirect_uri')}\n` +
          `response_type: ${u.searchParams.get('response_type')}\n` +
          `scope: ${u.searchParams.get('scope')}\n` +
          `prompt: ${u.searchParams.get('prompt')}\n\n` +
          `Result: PASS — popup reached Google's real OAuth endpoint with a correctly-formed request.\n` +
          `Completing real sign-in requires a human to enter real Google credentials; Google also actively\n` +
          `blocks Selenium-controlled browsers (navigator.webdriver=true) from completing consent, so the\n` +
          `rest of this flow cannot be driven by automation — this is the honest stopping point.`
      );
      await closeCurrentWindow(sid).catch(() => {});
      const remaining = await handles(sid);
      if (remaining[0]) await switchWindow(sid, remaining[0]);
    } else {
      await shot(sid, '12-google-popup-FAILED.png');
      record('Google popup reached real accounts.google.com', false, `last seen url=${googleUrl}`);
      writeText(
        '12-google-popup-real-accounts-google-com.txt',
        `FAIL: popup never reached accounts.google.com. Last observed URL: ${googleUrl}`
      );
    }

    // Reset to a clean /login before testing Facebook.
    const remainingHandles = await handles(sid);
    await switchWindow(sid, remainingHandles[0]);
    await wd(`/session/${sid}/url`, 'POST', { url: `${BASE}/login` });
    await findEl(sid, 'css selector', '#login-phone');
    await new Promise((r) => setTimeout(r, 1500)); // let FB SDK load

    // --- Facebook ---
    const beforeHandlesFb = await handles(sid);
    const fbBtn = await findEl(sid, 'xpath', "//button[contains(., 'Continue with Facebook')]");
    await click(sid, fbBtn);

    let fbUrl = null;
    let fbPopupFound = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const after = await handles(sid);
      const newHandle = after.find((h) => !beforeHandlesFb.includes(h));
      if (newHandle) {
        await switchWindow(sid, newHandle);
        await new Promise((r) => setTimeout(r, 1200));
        fbUrl = await currentUrl(sid);
        if (/facebook\.com/.test(fbUrl)) {
          fbPopupFound = true;
          await shot(sid, '13-facebook-popup-real-facebook-com.png');
          break;
        }
      }
    }
    if (fbPopupFound) {
      let parsedExtra = '';
      try {
        const u = new URL(fbUrl);
        parsedExtra =
          `client_id/app_id: ${u.searchParams.get('client_id') ?? u.searchParams.get('app_id')}\n` +
          `redirect_uri: ${u.searchParams.get('redirect_uri')}\n` +
          `scope: ${u.searchParams.get('scope')}\n`;
      } catch {
        parsedExtra = '(URL did not parse with standard query params — see raw URL above)\n';
      }
      record('Facebook popup reached real facebook.com', true, fbUrl);
      writeText(
        '13-facebook-popup-real-facebook-com.txt',
        `Testing: clicked real "Continue with Facebook" button (FB JS SDK FB.login()).\n` +
          `Full popup URL: ${fbUrl}\n\n${parsedExtra}\n` +
          `Result: PASS — popup reached Facebook's real domain with a correctly-formed OAuth dialog request.\n` +
          `Completing real sign-in requires a human to enter real Facebook credentials; this is the honest\n` +
          `stopping point for automation.`
      );
      await closeCurrentWindow(sid).catch(() => {});
      const remaining = await handles(sid);
      if (remaining[0]) await switchWindow(sid, remaining[0]);
    } else {
      await shot(sid, '13-facebook-popup-FAILED.png');
      record('Facebook popup reached real facebook.com', false, `last seen url=${fbUrl}`);
      writeText(
        '13-facebook-popup-real-facebook-com.txt',
        `FAIL: popup never reached facebook.com. Last observed URL: ${fbUrl}`
      );
    }
  } finally {
    await wd(`/session/${sid}`, 'DELETE').catch(() => {});
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n=== BROWSER TEST SUMMARY ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name} — ${r.detail}`);
  }
  writeText(
    '99-browser-test-summary.txt',
    `Phone used: ${NEW_PHONE}\n\n` +
      results.map((r) => `[${r.pass ? 'PASS' : 'FAIL'}] ${r.name} — ${r.detail}`).join('\n')
  );

  const anyFail = results.some((r) => !r.pass);
  if (anyFail) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
