import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'router-merge-check');
mkdirSync(PROOFS, { recursive: true });
const PHONE = String(Math.floor(9000000000 + Math.random() * 999999999)).slice(0, 10);

async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.value;
}
function elId(el) { return el['element-6066-11e4-a52e-4f735466cecf']; }
async function findEl(sid, using, value, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error(`element not found: ${using}=${value}`);
}
async function pageInfo(sid) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script: `return { url: location.href, text: document.body.innerText.slice(0, 800) };`, args: [] });
}
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  writeFileSync(join(PROOFS, name), Buffer.from(png, 'base64'));
}

let sid;
try {
  const session = await wd('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:5173`] } } } });
  sid = session.sessionId;

  await wd(`/session/${sid}/url`, 'POST', { url: `http://${HOST}:5173/login` });
  const phoneEl = await findEl(sid, 'css selector', '#login-phone');
  await wd(`/session/${sid}/element/${elId(phoneEl)}/value`, 'POST', { text: PHONE });
  const sendBtn = await findEl(sid, 'xpath', "//button[contains(., 'Send OTP')]");
  await wd(`/session/${sid}/element/${elId(sendBtn)}/click`, 'POST', {});
  await new Promise(r => setTimeout(r, 2500));

  let info = await pageInfo(sid);
  const codeMatch = info.text.match(/Dev code:\s*(\d+)/);
  if (!codeMatch) throw new Error('No dev code shown: ' + info.text);
  console.log('Got dev OTP:', codeMatch[1], 'for phone', PHONE);

  const otpEl = await findEl(sid, 'css selector', '#login-otp');
  await wd(`/session/${sid}/element/${elId(otpEl)}/clear`, 'POST', {}).catch(() => {});
  await wd(`/session/${sid}/element/${elId(otpEl)}/value`, 'POST', { text: codeMatch[1] });
  const verifyBtn = await findEl(sid, 'xpath', "//button[contains(., 'Verify')]");
  await wd(`/session/${sid}/element/${elId(verifyBtn)}/click`, 'POST', {});
  await new Promise(r => setTimeout(r, 3000));

  info = await pageInfo(sid);
  await shot(sid, 'after-otp-login.png');
  console.log('Final URL after verify:', info.url);
  console.log('Page text:', info.text.slice(0, 400));

  const hitPhoneGateWrongly = /unexpected|error|cannot read|undefined/i.test(info.text);
  const reachedOnboardingOrDashboard = /onboarding|dashboard|business|store/i.test(info.url) || /set up your business|legal business name/i.test(info.text);
  console.log('\n=== VERDICT ===');
  console.log('Crashed/error text present:', hitPhoneGateWrongly, '(want false)');
  console.log('Reached onboarding/dashboard (PhoneGate let a verified-phone OTP user through):', reachedOnboardingOrDashboard, '(want true)');
} finally {
  if (sid) await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
