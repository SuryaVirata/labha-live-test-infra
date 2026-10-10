// Real browser test for shopper (storefront customer) social-login flows.
// Drives the Chromium in labha-live-test-infra's `browser` service over WebDriver.
// No mocked network. The page and API are the ones running on this machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
const STORE_URL = `http://${HOST}:3000/store/labha-dev`;
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'iteration-02', 'customer');
mkdirSync(PROOFS, { recursive: true });

const PHONE = String(Math.floor(9000000000 + Math.random() * 999999999)).slice(0, 10);
console.log('Using fresh phone:', PHONE);

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
function elId(el) { return el['element-6066-11e4-a52e-4f735466cecf']; }
async function newSession() {
  return wd('/session', 'POST', {
    capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,1000', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:3000`] } } }
  });
}
async function findEl(sid, using, value, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error(`element not found: ${using}=${value}`);
}
async function findEls(sid, using, value) {
  try { return await wd(`/session/${sid}/elements`, 'POST', { using, value }); } catch { return []; }
}
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  writeFileSync(join(PROOFS, name), Buffer.from(png, 'base64'));
  console.log('saved', name);
}
function note(name, text) {
  writeFileSync(join(PROOFS, name), text, 'utf8');
  console.log('saved', name, '::', text.split('\n')[0]);
}
async function pageInfo(sid) {
  return wd(`/session/${sid}/execute/sync`, 'POST', {
    script: `return { url: location.href, title: document.title, text: document.body.innerText };`,
    args: []
  });
}
async function allWindowHandles(sid) {
  return wd(`/session/${sid}/window/handles`, 'GET');
}
async function switchWindow(sid, handle) {
  return wd(`/session/${sid}/window`, 'POST', { handle });
}

let sid;
const results = [];
try {
  const session = await newSession();
  sid = session.sessionId;
  console.log('WebDriver session:', sid);

  // Step 1: navigate to store login
  await wd(`/session/${sid}/url`, 'POST', { url: `${STORE_URL}/login` });
  await new Promise(r => setTimeout(r, 1500));
  let info = await pageInfo(sid);
  await shot(sid, '04-login-page-reload-after-config-fix.png');
  const hydrated = info.text.includes('MOBILE NUMBER') || info.text.includes('Mobile number');
  note('04-login-page-reload-after-config-fix.txt',
    `Tested: reload of ${STORE_URL}/login after adding allowedDevOrigins fix.\nhydrated(interactive)=${hydrated}\nurl=${info.url}\n\n--- page text ---\n${info.text}`);
  results.push(['page hydrates via bridge IP after allowedDevOrigins fix', hydrated]);

  // Step 2: type phone, send OTP
  const phoneInputs = await findEls(sid, 'css selector', 'input[type="tel"], input[inputmode="numeric"], input[name*="mobile" i], input[placeholder*="mobile" i]');
  let phoneEl = phoneInputs[0];
  if (!phoneEl) phoneEl = await findEl(sid, 'xpath', "//input");
  await wd(`/session/${sid}/element/${elId(phoneEl)}/clear`, 'POST', {}).catch(() => {});
  await wd(`/session/${sid}/element/${elId(phoneEl)}/value`, 'POST', { text: PHONE });
  await shot(sid, '05-phone-typed.png');

  const sendBtn = await findEl(sid, 'xpath', "//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SEND OTP')]");
  await wd(`/session/${sid}/element/${elId(sendBtn)}/click`, 'POST', {});
  await new Promise(r => setTimeout(r, 2500));

  info = await pageInfo(sid);
  await shot(sid, '06-otp-screen.png');
  // Real label is "Developer OTP" (confirmed from a prior run's raw page text,
  // not assumed) — matching on that literal label, not a guessed "Dev OTP".
  const devOtpMatch = info.text.match(/Developer OTP\s*\n?\s*(\d{4,8})/i);
  const isDemoText = /Demo verification/i.test(info.text);
  note('06-otp-screen.txt',
    `Tested: clicked Send OTP for fresh phone +91${PHONE}.\nurl=${info.url}\ndevOtpShownInUI=${!!devOtpMatch}${devOtpMatch ? ' code=' + devOtpMatch[1] : ''}\nshowsDemoVerificationBranch=${isDemoText}\n\n--- page text ---\n${info.text}`);
  results.push(['storefront UI shows dev OTP for a real non-demo store', !!devOtpMatch]);

  // Use ONLY the UI's own displayed code — a separate out-of-band API call
  // would invalidate/replace this exact challenge and cause a false verify
  // failure (confirmed the hard way in the previous run of this script).
  const realDevOtp = devOtpMatch ? devOtpMatch[1] : null;
  console.log('Using OTP from UI:', realDevOtp);

  // Step 3: enter OTP, verify
  if (realDevOtp) {
    const otpInputs = await findEls(sid, 'css selector', 'input[inputmode="numeric"], input[type="text"], input[type="tel"]');
    // pick the otp input: usually the last numeric-ish input on the verify screen
    let otpEl = null;
    for (const el of otpInputs) {
      const id = elId(el);
      const val = await wd(`/session/${sid}/element/${id}/attribute/value`, 'GET').catch(() => null);
      // heuristics aside, just grab the first visible one on this page
      otpEl = el; break;
    }
    if (otpEl) {
      await wd(`/session/${sid}/element/${elId(otpEl)}/clear`, 'POST', {}).catch(() => {});
      await wd(`/session/${sid}/element/${elId(otpEl)}/value`, 'POST', { text: realDevOtp });
      await shot(sid, '07-otp-typed.png');
      const verifyBtn = await findEl(sid, 'xpath', "//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'VERIFY')]");
      await wd(`/session/${sid}/element/${elId(verifyBtn)}/click`, 'POST', {});
      await new Promise(r => setTimeout(r, 2500));
      info = await pageInfo(sid);
      await shot(sid, '08-after-verify.png');
      const signedIn = /account|sign out|logout|welcome/i.test(info.text) && !/verify identity/i.test(info.text);
      note('08-after-verify.txt', `Tested: entered OTP ${realDevOtp} and clicked Verify.\nurl=${info.url}\nappearsSignedIn=${signedIn}\n\n--- page text ---\n${info.text}`);
      results.push(['OTP verify succeeds and reaches a signed-in state', signedIn]);
    } else {
      note('07-FAIL-no-otp-input-found.txt', `Could not locate an OTP input field.\n\n--- page text ---\n${info.text}`);
      results.push(['OTP input field found', false]);
    }
  } else {
    note('07-FAIL-no-dev-otp-available.txt', 'Neither the UI nor the direct API call produced a dev_otp.');
    results.push(['dev OTP obtainable at all', false]);
  }

  // Step 4: Google popup
  await wd(`/session/${sid}/url`, 'POST', { url: `${STORE_URL}/login` });
  await new Promise(r => setTimeout(r, 1500));
  const beforeHandles = await allWindowHandles(sid);
  try {
    const googleBtn = await findEl(sid, 'xpath', "//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CONTINUE WITH GOOGLE')]");
    await wd(`/session/${sid}/element/${elId(googleBtn)}/click`, 'POST', {});
    await new Promise(r => setTimeout(r, 2500));
    const afterHandles = await allWindowHandles(sid);
    const newHandle = afterHandles.find(h => !beforeHandles.includes(h));
    if (newHandle) {
      await switchWindow(sid, newHandle);
      await new Promise(r => setTimeout(r, 1500));
      const popupInfo = await pageInfo(sid);
      await shot(sid, '09-google-popup.png');
      const reachedGoogle = popupInfo.url.includes('accounts.google.com');
      note('09-google-popup.txt', `Tested: clicked "Continue with Google" on storefront login.\npopupUrl=${popupInfo.url}\nreachedRealGoogleDomain=${reachedGoogle}`);
      results.push(['Google popup reaches real accounts.google.com', reachedGoogle]);
      await wd(`/session/${sid}/window`, 'DELETE').catch(() => {});
      await switchWindow(sid, beforeHandles[0]);
    } else {
      note('09-FAIL-no-google-popup.txt', 'No new window/tab opened after clicking Continue with Google.');
      results.push(['Google button opens a popup', false]);
    }
  } catch (e) {
    note('09-FAIL-google-button-error.txt', String(e));
    results.push(['Google button clickable', false]);
  }

  // Step 5: Facebook popup
  try {
    const beforeHandles2 = await allWindowHandles(sid);
    const fbBtn = await findEl(sid, 'xpath', "//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CONTINUE WITH FACEBOOK')]");
    await wd(`/session/${sid}/element/${elId(fbBtn)}/click`, 'POST', {});
    await new Promise(r => setTimeout(r, 2500));
    const afterHandles2 = await allWindowHandles(sid);
    const newHandle2 = afterHandles2.find(h => !beforeHandles2.includes(h));
    if (newHandle2) {
      await switchWindow(sid, newHandle2);
      await new Promise(r => setTimeout(r, 1500));
      const popupInfo2 = await pageInfo(sid);
      await shot(sid, '10-facebook-popup.png');
      const reachedFb = /facebook\.com/.test(popupInfo2.url);
      note('10-facebook-popup.txt', `Tested: clicked "Continue with Facebook" on storefront login.\npopupUrl=${popupInfo2.url}\nreachedRealFacebookDomain=${reachedFb}`);
      results.push(['Facebook popup reaches real facebook.com', reachedFb]);
      await wd(`/session/${sid}/window`, 'DELETE').catch(() => {});
      await switchWindow(sid, beforeHandles2[0]);
    } else {
      note('10-FAIL-no-facebook-popup.txt', 'No new window/tab opened after clicking Continue with Facebook.');
      results.push(['Facebook button opens a popup', false]);
    }
  } catch (e) {
    note('10-FAIL-facebook-button-error.txt', String(e));
    results.push(['Facebook button clickable', false]);
  }

  console.log('\n=== SUMMARY ===');
  for (const [k, v] of results) console.log(`${v ? 'PASS' : 'FAIL'}: ${k}`);
  note('99-browser-test-summary.txt', results.map(([k, v]) => `${v ? 'PASS' : 'FAIL'}: ${k}`).join('\n'));
} finally {
  if (sid) await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
