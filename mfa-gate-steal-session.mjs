// Extract the browser session's refresh token so the same session's
// mfa/status answer can be replayed outside the page.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const WD = 'http://localhost:4444/wd/hub';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-gate-test');
async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return json.value;
}
const elId = (el) => el['element-6066-11e4-a52e-4f735466cecf'];
async function newSession() {
  return wd('/session', 'POST', {
    capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
  });
}
async function find(sid, using, value, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('not found ' + value);
}
async function click(sid, el) { await wd(`/session/${sid}/element/${elId(el)}/click`, 'POST', {}); }
async function type(sid, el, text) {
  await wd(`/session/${sid}/element/${elId(el)}/clear`, 'POST', {});
  await wd(`/session/${sid}/element/${elId(el)}/value`, 'POST', { text });
}
async function js(sid, script) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script, args: [] });
}
const session = await newSession();
const sid = session.sessionId;
try {
  await wd(`/session/${sid}/url`, 'POST', { url: 'http://localhost:5173/login' });
  await new Promise((r) => setTimeout(r, 5000));
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Platform admin')]"));
  await new Promise((r) => setTimeout(r, 800));
  await type(sid, await find(sid, 'css selector', '#admin-email'), 'root@labha.dev');
  await type(sid, await find(sid, 'css selector', '#admin-password'), 'Labha123!');
  await click(sid, await find(sid, 'xpath', "//form//button[contains(., 'Sign in')]"));
  await new Promise((r) => setTimeout(r, 8000));
  const stored = await js(sid, 'return sessionStorage.getItem("labha-auth");');
  writeFileSync(join(PROOFS, 'session-storage.json'), stored ?? 'null');
  console.log('STORED-LEN:', (stored ?? '').length);
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
