// End-to-end proof for the MFA-recovery AAL step-up fix (dashboard).
//
// 1. Real login against the live API (aal=1, password only).
// 2. Real call to the AAL-2-gated recovery queue -> must be 403 AUTH_AAL_REQUIRED.
// 3. Browser with that AAL-1 session restored from storage (same device id):
//    /console/mfa-recovery must show the "Verify your authenticator" explainer
//    (never the dead-end "Something went wrong"), and "Verify now" must land on
//    /login?next=%2Fconsole%2Fmfa-recovery with the sign-in form.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const DASH = 'http://localhost:5173';
const API = 'http://localhost:8080/api/v1';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-aal-stepup');
mkdirSync(PROOFS, { recursive: true });

const deviceId = `aal-ui-${Date.now()}`;
const summary = { deviceId, steps: {} };
let failures = 0;
function assert(label, ok, detail = '') {
  summary.steps[label] = ok ? 'PASS' : `FAIL ${detail}`;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`);
}

function jwtClaims(token) {
  const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
}

// 1-2. Live endpoint proof -------------------------------------------------
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'root@labha.dev', password: 'Labha123!', device_id: deviceId })
});
const login = await loginRes.json();
assert('login_http_200', loginRes.status === 200, `status=${loginRes.status}`);
const claims = jwtClaims(login.access_token);
summary.loginClaims = { aal: claims.aal, role: claims.role, device_id: claims.device_id };
assert('login_mints_aal1', claims.aal === 1, `aal=${claims.aal}`);
assert('login_device_matches', claims.device_id === deviceId);

const queueRes = await fetch(`${API}/auth/mfa/recovery/requests`, {
  headers: { Authorization: `Bearer ${login.access_token}` }
});
const queueBody = await queueRes.json().catch(() => ({}));
summary.queueResponse = { status: queueRes.status, body: queueBody };
assert('queue_http_403', queueRes.status === 403, `status=${queueRes.status}`);
assert('queue_code_auth_aal_required', queueBody?.error?.code === 'AUTH_AAL_REQUIRED', JSON.stringify(queueBody));

// 3. Browser proof ---------------------------------------------------------
async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.value;
}
const elId = (el) => el['element-6066-11e4-a52e-4f735466cecf'];
async function find(sessionId, using, value, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      return await wd(`/session/${sessionId}/element`, 'POST', { using, value });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`element not found: ${using}=${value}`);
}
async function click(sessionId, el) {
  await wd(`/session/${sessionId}/element/${elId(el)}/click`, 'POST', {});
}
async function bodyText(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText.slice(0, 4000);',
    args: []
  });
}
async function currentUrl(sessionId) {
  return wd(`/session/${sessionId}/url`, 'GET');
}
async function shot(sessionId, name) {
  const png = await wd(`/session/${sessionId}/screenshot`, 'GET');
  writeFileSync(join(PROOFS, name), Buffer.from(png, 'base64'));
  console.log('saved', join(PROOFS, name));
}

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
});
const sid = session.sessionId;
console.log('session', sid);
try {
  // Warm the app origin, then plant the AAL-1 session exactly like a reloaded tab.
  await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/login` });
  await new Promise((r) => setTimeout(r, 5000));
  await wd(`/session/${sid}/execute/sync`, 'POST', {
    script: `
      localStorage.setItem('labha-device-id', arguments[0]);
      sessionStorage.setItem('labha-auth', JSON.stringify({
        state: {
          isAuthenticated: true,
          user: { id: '20000000-0000-4000-8000-000000000001', email: 'root@labha.dev', roleCode: 'ROOT_ADMIN', merchantId: null },
          permissions: ['platform.admin'],
          stores: [],
          activeStoreSlug: null,
          refreshToken: arguments[1],
          hasActiveSubscription: true
        },
        version: 0
      }));
      return 'planted';`,
    args: [deviceId, login.refresh_token]
  });

  // Land on the recovery page with the AAL-1 session.
  await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/console/mfa-recovery` });
  let page = '';
  let sawExplainer = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    page = await bodyText(sid);
    if (page.includes('Verify your authenticator to view this page') || page.includes('Something went wrong')) {
      sawExplainer = true;
      break;
    }
  }
  const url1 = await currentUrl(sid);
  summary.pageUrl = url1;
  assert('explainer_seen', page.includes('Verify your authenticator to view this page'), page.slice(0, 200).replace(/\n/g, ' | '));
  assert('generic_error_absent', !page.includes('Something went wrong'));
  assert('stayed_on_recovery_url', url1.includes('/console/mfa-recovery'), url1);
  await shot(sid, '01-aal1-explainer.png');

  // "Verify now" -> login with return path.
  if (!sawExplainer) throw new Error('page never settled');
  const btn = await find(sid, 'xpath', "//button[contains(., 'Verify now')]");
  await click(sid, btn);
  let url2 = '';
  let loginBody = '';
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    url2 = await currentUrl(sid);
    loginBody = await bodyText(sid);
    if (url2.includes('/login') && loginBody.includes('Sign in to Labha')) break;
  }
  const decoded = decodeURIComponent(url2);
  summary.afterVerifyNowUrl = url2;
  assert('verify_now_lands_on_login', url2.includes('/login?next='), url2);
  assert('return_path_is_recovery_queue', decoded.includes('/console/mfa-recovery'), decoded);
  assert('login_form_shown', loginBody.includes('Sign in to Labha'));
  await shot(sid, '02-verify-now-login-next.png');

  summary.result = failures === 0 ? 'ALL-PASS' : `${failures}-FAILED`;
  writeFileSync(join(PROOFS, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('SUMMARY', JSON.stringify(summary, null, 2));
  console.log(summary.result);
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
if (failures > 0) process.exit(1);
