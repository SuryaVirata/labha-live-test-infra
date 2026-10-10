// Full merchant MFA journey: phone-OTP login → profile → enable TOTP →
// recovery codes → logout → re-login (phone OTP + TOTP challenge) → restore.
// Screenshots per step + every browser API call captured from fetch/XHR.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const DASH = 'http://localhost:5173';
const API = 'http://localhost:8080/api/v1';
const PHONE = '9765432101';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-full-journey', 'merchant');
mkdirSync(OUT, { recursive: true });

const journal = [];
let apiCursor = 0;

function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const bytes = [];
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totp(secret, step) {
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32(secret)).update(ctr).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 250)}`);
  return json.value;
}
const elId = (el) => el['element-6066-11e4-a52e-4f735466cecf'];
async function find(sid, using, value, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await sleep(500); }
  }
  throw new Error(`element not found: ${using}=${value}`);
}
async function tryFind(sid, using, value, retries = 6) {
  try { return await find(sid, using, value, retries); } catch { return null; }
}
const click = async (sid, el) => {
  try { await wd(`/session/${sid}/element/${elId(el)}/click`, 'POST', {}); }
  catch {
    await wd(`/session/${sid}/execute/sync`, 'POST', {
      script: 'arguments[0].scrollIntoView({block:"center"}); arguments[0].click();',
      args: [{ 'element-6066-11e4-a52e-4f735466cecf': elId(el) }]
    });
  }
};
async function type(sid, el, text) {
  await wd(`/session/${sid}/element/${elId(el)}/clear`, 'POST', {});
  await wd(`/session/${sid}/element/${elId(el)}/value`, 'POST', { text });
}
const bodyText = (sid) => wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return document.body.innerText.slice(0, 6000);', args: [] });
const currentUrl = (sid) => wd(`/session/${sid}/url`, 'GET');
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  writeFileSync(join(OUT, name), Buffer.from(png, 'base64'));
}
async function apiLog(sid) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return window.__apiLog || [];', args: [] });
}
async function step(sid, id, description, shotName) {
  if (shotName) await shot(sid, shotName);
  const all = await apiLog(sid);
  const delta = all.slice(apiCursor);
  apiCursor = all.length;
  journal.push({ step: id, description, screenshot: shotName ?? null, api: delta });
  console.log(`STEP ${id}: ${description}${shotName ? ' [' + shotName + ']' : ''}`);
}
async function injectLogger(sid) {
  await wd(`/session/${sid}/execute/sync`, 'POST', {
    script: `
      if (!window.__apiLog) {
        window.__apiLog = [];
        const OX = window.XMLHttpRequest;
        function WX() {
          const xhr = new OX();
          let m = 'GET', u = '';
          const oo = xhr.open;
          xhr.open = function (method, url, ...rest) { m = method; u = String(url); return oo.call(xhr, method, url, ...rest); };
          const os = xhr.send;
          xhr.send = function (...a) {
            xhr.addEventListener('loadend', function () { window.__apiLog.push({ url: u, method: m, status: xhr.status, body: String(xhr.responseText || '').slice(0, 4000) }); });
            return os.apply(xhr, a);
          };
          return xhr;
        }
        WX.prototype = OX.prototype;
        window.XMLHttpRequest = WX;
      }
      return 'ok';`,
    args: []
  });
}
async function goto(sid, url) {
  await wd(`/session/${sid}/url`, 'POST', { url });
  await sleep(4500);
  await injectLogger(sid);
}
async function ensureMerchantTab(sid) {
  for (let i = 0; i < 8; i++) {
    const phone = await tryFind(sid, 'css selector', '#login-phone', 2);
    if (phone) return;
    const tab = await tryFind(sid, 'xpath', "//button[contains(., 'Merchant')]", 4);
    if (tab) await click(sid, tab);
    await sleep(1000);
  }
  throw new Error('could not switch to Merchant tab');
}
async function fillAndSendOtp(sid) {
  await injectLogger(sid);
  await ensureMerchantTab(sid);
  await type(sid, await find(sid, 'css selector', '#login-phone'), PHONE);
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Send OTP')]"));
  const otpInput = await find(sid, 'css selector', '#login-otp');
  // read the dev OTP from the app's own /otp/request
  let otp = null;
  for (let i = 0; i < 20 && !otp; i++) {
    await sleep(600);
    const all = await apiLog(sid);
    const hit = [...all].reverse().find((e) => e.url.includes('/otp/request') && e.status >= 200 && e.status < 300);
    if (hit) { try { otp = JSON.parse(hit.body).dev_otp; } catch {} }
  }
  if (!otp) throw new Error('dev OTP not captured from /otp/request response');
  await type(sid, otpInput, otp);
  return otpInput;
}

// preflight: merchant must start unenrolled
const pre = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@labha.dev', password: 'Labha123!', device_id: `journey-merchant-pre-${Date.now()}` })
}).then((r) => r.json());
const preStatus = await fetch(`${API}/auth/mfa/status`, { headers: { Authorization: `Bearer ${pre.access_token}` } }).then((r) => r.json());
if (preStatus.enrolled) {
  console.error('PRECONDITION FAILED: merchant already enrolled; aborting.');
  process.exit(1);
}
journal.push({ step: 'preflight', description: 'merchant starts unenrolled', api: [{ url: '/auth/mfa/status', method: 'GET', status: 200, body: JSON.stringify(preStatus) }] });

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
});
const sid = session.sessionId;
console.log('session', sid);

let confirmStep = null;
try {
  await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/login` });
  await sleep(4000);
  await injectLogger(sid);
  await ensureMerchantTab(sid);
  await step(sid, 1, 'Login page — Merchant tab', '01-login-merchant.png');

  await type(sid, await find(sid, 'css selector', '#login-phone'), PHONE);
  await step(sid, 2, `Phone entered (${PHONE})`, '02-phone-entered.png');

  const otpInput = await fillAndSendOtp(sid);
  await step(sid, 3, 'OTP sent; dev code captured; code entered', '03-otp-entered.png');
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify & sign in')]"));
  let home = false;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    if (!(await currentUrl(sid)).includes('/login')) { home = true; break; }
  }
  if (!home) throw new Error('merchant OTP login did not leave /login');
  await step(sid, 4, 'Merchant logged in (phone OTP) — no MFA prompt yet (unenrolled)', '04-merchant-home.png');

  // open the store shell directly (owner owns labha-dev; PlanGate passes with
  // the ACTIVE test subscription) then the profile page
  await goto(sid, `${DASH}/store/labha-dev/profile`);
  const dismiss = await tryFind(sid, 'xpath', "//button[contains(., 'look around first')]", 3);
  if (dismiss) await click(sid, dismiss);
  let hasCard = false;
  for (let i = 0; i < 30; i++) {
    await sleep(900);
    const t = await bodyText(sid);
    if (/two-factor authentication/i.test(t)) { hasCard = true; break; }
    if (t.includes('Sign in to Labha')) throw new Error('store profile bounced to login');
  }
  if (!hasCard) throw new Error('MFA card not found on merchant profile');
  await step(sid, 5, 'Merchant profile (store shell) — Two-factor authentication card (Off)', '05-profile-mfa-off.png');

  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Set up authenticator app')]"));
  let startHit = null;
  for (let i = 0; i < 20 && !startHit; i++) {
    await sleep(700);
    const all = await apiLog(sid);
    startHit = [...all].reverse().find((e) => e.url.includes('/mfa/enroll/start'));
  }
  await step(sid, 6, 'Enrollment started — QR + manual key visible', '06-qr-manual-key.png');
  let secret = null;
  if (startHit) { try { secret = JSON.parse(startHit.body).manual_key; } catch {} }
  if (!secret) {
    const t = await bodyText(sid);
    const m = t.match(/\b([A-Z2-7]{16,})\b/);
    if (m) secret = m[1];
  }
  if (!secret) throw new Error('could not obtain TOTP secret');

  const now = Math.floor(Date.now() / 1000);
  const wait = 30 - (now % 30) + 2;
  await sleep(wait * 1000);
  confirmStep = Math.floor(Date.now() / 1000 / 30);
  await type(sid, await find(sid, 'xpath', "//input[@aria-label='Authenticator code'] | //input[@placeholder='123456']"), totp(secret, confirmStep));
  await step(sid, 7, `Authenticator code entered (step ${confirmStep})`, '07-code-entered.png');
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify and enable')]"));
  let codesShown = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await bodyText(sid);
    if (/recovery code/i.test(t) && (t.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g) || []).length >= 5) { codesShown = true; break; }
  }
  if (!codesShown) throw new Error('recovery codes screen did not appear');
  await step(sid, 8, 'MFA enabled — recovery codes shown', '08-recovery-codes.png');

  // logout
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'owner@labha.dev')] | //button[contains(., 'owner')]"));
  await sleep(800);
  await click(sid, await find(sid, 'xpath', "//*[normalize-space(text())='Log out']"));
  let onLogin = false;
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    if ((await bodyText(sid)).includes('Sign in to Labha')) { onLogin = true; break; }
  }
  if (!onLogin) throw new Error('logout did not return to login');
  await step(sid, 9, 'Logged out', '09-after-logout.png');

  // re-login -> OTP -> TOTP gate
  await fillAndSendOtp(sid);
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify & sign in')]"));
  let gateShown = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (/authenticator code/i.test(await bodyText(sid))) { gateShown = true; break; }
  }
  if (!gateShown) throw new Error('TOTP gate did not appear after merchant re-login');
  await step(sid, 10, 'Re-login — TOTP challenge gate shown', '10-totp-gate.png');

  const chalStep = Math.max(Math.floor(Date.now() / 1000 / 30), confirmStep + 1);
  await type(sid, await find(sid, 'css selector', '#admin-mfa-code'), totp(secret, chalStep));
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify') and not(contains(., 'sign in'))]"));
  home = false;
  for (let i = 0; i < 30; i++) {
    await sleep(900);
    if (!(await currentUrl(sid)).includes('/login')) { home = true; break; }
  }
  if (!home) throw new Error('challenge did not complete merchant login');
  await step(sid, 11, `TOTP challenge passed (step ${chalStep}) — merchant in`, '11-merchant-after-challenge.png');

  // restore
  const all = await apiLog(sid);
  const chalHit = [...all].reverse().find((e) => e.url.includes('/mfa/challenge') && e.status === 200);
  if (!chalHit) throw new Error('challenge response not captured');
  const aal2 = JSON.parse(chalHit.body).access_token;
  const dis = await fetch(`${API}/auth/mfa/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aal2}` },
    body: '{}'
  });
  journal.push({ step: 12, description: 'Restore: AAL-2 disable', api: [{ url: '/mfa/disable', method: 'POST', status: dis.status, body: (await dis.text()).slice(0, 200) }] });
  console.log(`STEP 12: AAL-2 disable -> HTTP ${dis.status}`);
  const after = await fetch(`${API}/auth/mfa/status`, { headers: { Authorization: `Bearer ${aal2}` } }).then((r) => r.json());
  journal.push({ step: 12.1, description: 'State restored', api: [{ url: '/mfa/status', method: 'GET', status: 200, body: JSON.stringify(after) }] });
  if (after.enrolled !== false) {
    throw new Error(`restore not confirmed: ${JSON.stringify(after).slice(0, 200)}`);
  }
  await shot(sid, '12-after-disable.png');
  console.log('DONE');
} catch (err) {
  console.error('JOURNEY FAILED:', err.message);
  try { await shot(sid, '99-FAILURE.png'); } catch {}
  try {
    const diag = await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return { href: location.href, text: document.body.innerText.slice(0, 400), log: (window.__apiLog || []).slice(-10) };', args: [] });
    writeFileSync(join(OUT, 'failure-diag.json'), JSON.stringify(diag, null, 2));
  } catch {}
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, 'journey.json'), JSON.stringify(journal, null, 2));
  console.log(`journal: ${journal.length} steps -> ${join(OUT, 'journey.json')}`);
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
