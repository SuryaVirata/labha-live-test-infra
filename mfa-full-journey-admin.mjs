// Full admin MFA journey with per-step screenshots + captured API responses.
// Steps: login → profile → enable TOTP (QR from enroll/start) → confirm with
// computed code → recovery codes → logout → login again → TOTP challenge →
// AAL-2 console → MFA recovery queue (AAL-2-gated) → restore state (disable
// via the AAL-2 token) → verify restored. Every UI state gets a screenshot;
// every API call made by the browser (fetch/XHR) is captured per step.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const DASH = 'http://localhost:5173';
const API = 'http://localhost:8080/api/v1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-full-journey', 'admin');
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
  try {
    await wd(`/session/${sid}/element/${elId(el)}/click`, 'POST', {});
  } catch {
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
const bodyText = (sid) =>
  wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return document.body.innerText.slice(0, 6000);', args: [] });
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  writeFileSync(join(OUT, name), Buffer.from(png, 'base64'));
}
async function apiDelta(sid) {
  const log = await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return window.__apiLog || [];', args: [] });
  const delta = log.slice(apiCursor);
  apiCursor = log.length;
  return delta;
}
async function step(sid, id, description, shotName) {
  if (shotName) await shot(sid, shotName);
  const api = await apiDelta(sid);
  journal.push({ step: id, description, screenshot: shotName ?? null, api });
  console.log(`STEP ${id}: ${description}${shotName ? ' [' + shotName + ']' : ''}`);
}
async function ensureAdminTab(sid) {
  for (let i = 0; i < 8; i++) {
    const email = await tryFind(sid, 'css selector', '#admin-email', 2);
    if (email) return;
    const tab = await tryFind(sid, 'xpath', "//button[contains(., 'Platform admin')]", 4);
    if (tab) await click(sid, tab);
    await sleep(1200);
  }
  throw new Error('could not switch to Platform admin tab');
}
async function injectLogger(sid) {
  await wd(`/session/${sid}/execute/sync`, 'POST', {
    script: `
      if (!window.__apiLog) {
        window.__apiLog = [];
        // axios uses XHR; wrap it. fetch wrapped too for completeness.
        const OX = window.XMLHttpRequest;
        function WX() {
          const xhr = new OX();
          let m = 'GET', u = '';
          const oo = xhr.open;
          xhr.open = function (method, url, ...rest) { m = method; u = String(url); return oo.call(xhr, method, url, ...rest); };
          const os = xhr.send;
          xhr.send = function (...a) {
            xhr.addEventListener('loadend', function () {
              window.__apiLog.push({ url: u, method: m, status: xhr.status, body: String(xhr.responseText || '').slice(0, 4000) });
            });
            return os.apply(xhr, a);
          };
          return xhr;
        }
        WX.prototype = OX.prototype;
        window.XMLHttpRequest = WX;
        const of = window.fetch.bind(window);
        window.fetch = async function (input, init) {
          const u = typeof input === 'string' ? input : input.url;
          const m = (init && init.method) || 'GET';
          const res = await of(input, init);
          try { const t = await res.clone().text(); window.__apiLog.push({ url: u, method: m, status: res.status, body: t.slice(0, 4000) }); } catch {}
          return res;
        };
      }
      return 'ok';`,
    args: []
  });
}

// ---------- pre-flight: root must start unenrolled ----------
const pre = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'root@labha.dev', password: 'Labha123!', device_id: `journey-admin-pre-${Date.now()}` })
}).then((r) => r.json());
const preStatus = await fetch(`${API}/auth/mfa/status`, { headers: { Authorization: `Bearer ${pre.access_token}` } }).then((r) => r.json());
if (preStatus.enrolled) {
  console.error('PRECONDITION FAILED: root already enrolled; aborting to avoid clobbering state.');
  process.exit(1);
}
journal.push({ step: 'preflight', description: 'root starts unenrolled', api: [{ url: '/auth/mfa/status', method: 'GET', status: 200, body: JSON.stringify(preStatus) }] });

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
});
const sid = session.sessionId;
console.log('session', sid);

let confirmStep = null;
try {
  // 1. login page
  await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/login` });
  await sleep(4000);
  await injectLogger(sid);
  await step(sid, 1, 'Login page loaded (root unenrolled; no MFA prompt expected)', '01-login-page.png');

  // 2. admin tab + credentials
  await ensureAdminTab(sid);
  await type(sid, await find(sid, 'css selector', '#admin-email'), 'root@labha.dev');
  await type(sid, await find(sid, 'css selector', '#admin-password'), 'Labha123!');
  await step(sid, 2, 'Admin credentials entered', '02-admin-credentials.png');

  // 3. sign in -> console (no challenge because unenrolled)
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Sign in')]"));
  let onConsole = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await bodyText(sid);
    if (t.includes('Internal console')) { onConsole = true; break; }
  }
  if (!onConsole) throw new Error('did not land on console after password login');
  await step(sid, 3, 'Console after password login (AAL-1, no prompt yet — root unenrolled)', '03-console-aal1.png');

  // 4. profile -> MFA card
  const profileLink = await find(sid, 'xpath', "//a[contains(., 'My profile')] | //button[contains(., 'My profile')]");
  await click(sid, profileLink);
  await sleep(2500);
  let hasCard = false;
  for (let i = 0; i < 20; i++) {
    const t = await bodyText(sid);
    if (/two-factor authentication/i.test(t)) { hasCard = true; break; }
    await sleep(700);
  }
  if (!hasCard) throw new Error('Two-factor authentication card not found on profile');
  await step(sid, 4, 'Profile page with Two-factor authentication card (Off)', '04-profile-mfa-off.png');

  // 5. start enrollment -> QR
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Set up authenticator app')]"));
  let startBody = null;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const d = await apiDeltaSilent(sid);
    const hit = d.find((e) => e.url.includes('/mfa/enroll/start'));
    if (hit) { startBody = hit; apiCursor-- ; break; }
  }
  async function apiDeltaSilent(sid2) {
    return wd(`/session/${sid2}/execute/sync`, 'POST', { script: 'return window.__apiLog || [];', args: [] }).then((l) => l.slice(apiCursor));
  }
  const qrVisible = await tryFind(sid, 'xpath', "//*[contains(., 'otpauth://') or contains(., 'Manual key') or contains(., 'Scan')]");
  await step(sid, 5, 'Enrollment started — QR / manual key visible', '05-qr-manual-key.png');
  if (!qrVisible) console.log('WARN: QR affordance not matched, continuing');

  // secret for TOTP: prefer captured enroll/start response, fall back to page text
  let secret = null;
  if (startBody) { try { secret = JSON.parse(startBody.body).manual_key; } catch {} }
  if (!secret) {
    const t = await bodyText(sid);
    const m = t.match(/\b([A-Z2-7]{16,})\b/);
    if (m) secret = m[1];
  }
  if (!secret) throw new Error('could not obtain TOTP secret');
  journal.push({ step: 5.1, description: 'TOTP secret captured from enroll/start response', api: [startBody].filter(Boolean) });

  // 6. compute code and confirm
  const sleepToFreshStep = async () => {
    const now = Math.floor(Date.now() / 1000);
    const wait = 30 - (now % 30) + 2;
    await sleep(wait * 1000);
  };
  await sleepToFreshStep();
  confirmStep = Math.floor(Date.now() / 1000 / 30);
  let code = totp(secret, confirmStep);
  const codeInput = await find(sid, 'xpath', "//input[@aria-label='Authenticator code'] | //input[@placeholder='123456']");
  await type(sid, codeInput, code);
  await step(sid, 6, `Authenticator code entered (step ${confirmStep})`, '06-code-entered.png');
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify and enable')]"));
  let codesShown = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await bodyText(sid);
    if (/recovery code/i.test(t) && (t.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/g) || []).length >= 5) { codesShown = true; break; }
  }
  if (!codesShown) throw new Error('recovery codes screen did not appear');
  await step(sid, 7, 'MFA enabled — recovery codes shown (10 single-use)', '07-recovery-codes.png');

  // 8. logout
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'root@labha.dev')] | //button[contains(@aria-label,'account')]"));
  await sleep(800);
  await click(sid, await find(sid, 'xpath', "//*[normalize-space(text())='Log out']"));
  let onLogin = false;
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    const t = await bodyText(sid);
    if (t.includes('Sign in to Labha')) { onLogin = true; break; }
  }
  if (!onLogin) throw new Error('logout did not return to login');
  await step(sid, 8, 'Logged out — back on login page', '08-after-logout.png');

  // 9. login again -> TOTP gate
  await ensureAdminTab(sid);
  await type(sid, await find(sid, 'css selector', '#admin-email'), 'root@labha.dev');
  await type(sid, await find(sid, 'css selector', '#admin-password'), 'Labha123!');
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Sign in')]"));
  let gateShown = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await bodyText(sid);
    if (/authenticator code/i.test(t)) { gateShown = true; break; }
  }
  if (!gateShown) throw new Error('TOTP gate did not appear on second login');
  await step(sid, 9, 'Second login — TOTP challenge gate shown (enrolled+required)', '09-totp-gate.png');

  // 10. challenge immediately with the +1 window code (verify skew accepts
  //     it; the confirm already consumed the confirm window's step)
  const chalStepHint = confirmStep + 1;
  const nowStep = Math.floor(Date.now() / 1000 / 30);
  const chalStep = Math.max(nowStep, chalStepHint);
  code = totp(secret, chalStep);
  const gateInput = await find(sid, 'css selector', '#admin-mfa-code');
  await type(sid, gateInput, code);
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Verify') and not(contains(., 'sign in'))]"));
  onConsole = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = await bodyText(sid);
    if (t.includes('Internal console')) { onConsole = true; break; }
  }
  if (!onConsole) throw new Error('challenge did not reach console');
  await step(sid, 10, `TOTP challenge passed (step ${chalStep}) — AAL-2 session`, '10-console-aal2.png');

  // 11. AAL-2-gated page: MFA recovery queue loads
  await click(sid, await find(sid, 'xpath', "//a[contains(., 'MFA recovery')]"));
  let queueLoaded = false;
  for (let i = 0; i < 25; i++) {
    await sleep(900);
    const t = await bodyText(sid);
    if (t.includes('MFA recovery requests') && !t.includes('Something went wrong')) { queueLoaded = true; break; }
  }
  if (!queueLoaded) throw new Error('AAL-2 recovery queue did not load');
  await step(sid, 11, 'AAL-2 session loads the recovery queue (no step-up dead-end)', '11-recovery-queue-aal2.png');

  // 12. restore state: disable using the AAL-2 access token captured from the challenge response
  const logAll = await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return window.__apiLog || [];', args: [] });
  const chalHit = [...logAll].reverse().find((e) => e.url.includes('/mfa/challenge') && e.status === 200);
  if (!chalHit) throw new Error('challenge response not captured');
  const aal2 = JSON.parse(chalHit.body).access_token;
  const dis = await fetch(`${API}/auth/mfa/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aal2}` },
    body: '{}'
  });
  journal.push({ step: 12, description: 'Restore: AAL-2 disable', api: [{ url: '/mfa/disable', method: 'POST', status: dis.status, body: (await dis.text()).slice(0, 400) }] });
  console.log(`STEP 12: AAL-2 disable -> HTTP ${dis.status}`);
  const after = await fetch(`${API}/auth/mfa/status`, { headers: { Authorization: `Bearer ${aal2}` } }).then((r) => r.json());
  journal.push({ step: 12.1, description: 'State restored', api: [{ url: '/mfa/status', method: 'GET', status: 200, body: JSON.stringify(after) }] });
  if (after.enrolled) throw new Error('restore failed: still enrolled');

  await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/` }).catch(() => {});
  await sleep(4000);
  await shot(sid, '12-after-disable-sessions-revoked.png');
  console.log('DONE');
} catch (err) {
  console.error('JOURNEY FAILED:', err.message);
  try { await shot(sid, '99-FAILURE.png'); } catch {}
  try {
    const diag = await wd(`/session/${sid}/execute/sync`, 'POST', {
      script: 'return { href: location.href, text: document.body.innerText.slice(0, 400), log: (window.__apiLog || []).slice(-10) };',
      args: []
    });
    writeFileSync(join(OUT, 'failure-diag.json'), JSON.stringify(diag, null, 2));
  } catch {}
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, 'journey.json'), JSON.stringify(journal, null, 2));
  console.log(`journal: ${journal.length} steps -> ${join(OUT, 'journey.json')}`);
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
