// Fresh test: enrolled ROOT_ADMIN, Platform-admin tab, email+password login.
// Expects the TOTP step (Authenticator code) instead of the console.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
// Browsed as plain localhost so the page Origin (http://localhost:5173) is in
// the backend's dev CORS allowlist — the same origin a real user has. A
// forwarder inside the container maps its own localhost ports to the host.
const HOST = 'localhost';
const URL = `http://${HOST}:5173/login`;
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-gate-test');
mkdirSync(PROOFS, { recursive: true });

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
async function newSession() {
  return wd('/session', 'POST', {
    capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
  });
}
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
async function type(sessionId, el, text) {
  await wd(`/session/${sessionId}/element/${elId(el)}/clear`, 'POST', {});
  await wd(`/session/${sessionId}/element/${elId(el)}/value`, 'POST', { text });
}
async function text(sessionId, el) {
  return wd(`/session/${sessionId}/element/${elId(el)}/text`, 'GET');
}
async function bodyText(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText.slice(0, 2000);',
    args: []
  });
}
async function shot(sessionId, name) {
  const png = await wd(`/session/${sessionId}/screenshot`, 'GET');
  const file = join(PROOFS, name);
  writeFileSync(file, Buffer.from(png, 'base64'));
  console.log('saved', file);
}

const session = await newSession();
const sid = session.sessionId;
console.log('session', sid);
try {
  await wd(`/session/${sid}/url`, 'POST', { url: URL });
  await new Promise((r) => setTimeout(r, 4000));
  await shot(sid, '01-login.png');

  // Switch to the Platform admin tab.
  const adminTab = await find(sid, 'xpath', "//button[contains(., 'Platform admin')]");
  await click(sid, adminTab);
  await new Promise((r) => setTimeout(r, 1000));

  // Fill credentials. Root seed account.
  const email = await find(sid, 'css selector', '#admin-email');
  await type(sid, email, 'root@labha.dev');
  const pass = await find(sid, 'css selector', '#admin-password');
  await type(sid, pass, 'Labha123!');
  await shot(sid, '02-filled.png');

  const signin = await find(sid, 'xpath', "//button[contains(., 'Sign in')]");
  await click(sid, signin);

  // Wait for EITHER the MFA step or the console.
  let seen = '';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    seen = await bodyText(sid);
    if (/Authenticator code|Recovery code/i.test(seen)) break;
    if (/My profile|Internal console|Merchants/i.test(seen)) break;
  }
  await shot(sid, '03-after-login.png');
  writeFileSync(join(PROOFS, 'body.txt'), seen);
  if (/Authenticator code|Recovery code/i.test(seen)) {
    console.log('RESULT: MFA-STEP-SHOWN');
  } else if (/My profile|Internal console/i.test(seen)) {
    console.log('RESULT: CONSOLE-WITHOUT-MFA (bug reproduced)');
  } else {
    console.log('RESULT: UNKNOWN-STATE');
  }
  console.log('---BODY---');
  console.log(seen.slice(0, 1200));
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
