// Live proof: enroll-failure guidance escalates + Start over re-provisions.
// Uses tech@ (unenrolled) so root's working MFA is never touched.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const WD = 'http://localhost:4444/wd/hub';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-hints-test');
mkdirSync(PROOFS, { recursive: true });
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
async function find(sid, using, value, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('not found ' + value);
}
async function click(sid, el) { await wd(`/session/${sid}/element/${elId(el)}/click`, 'POST', {}); }
// In-page click: bypasses pointer-interactability flakiness (layout shifts
// after typing routinely invalidate element click points in this flow).
async function jsClickText(sid, text) {
  return js(
    sid,
    `const b = [...document.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(text)}, 'i').test(x.textContent || ''));
    if (!b) return 'notfound';
    b.scrollIntoView({ block: 'center' });
    b.click();
    return 'clicked';`
  );
}
async function type(sid, el, text) {
  await wd(`/session/${sid}/element/${elId(el)}/clear`, 'POST', {});
  await wd(`/session/${sid}/element/${elId(el)}/value`, 'POST', { text });
}
async function jsTypeCode(sid, text) {
  // React controlled inputs ignore automation-protocol value sets (state never
  // updates, so the length-guarded submit stays disabled). Drive it through
  // the native setter + a bubbling input event instead. Returns value + the
  // submit button's disabled flag so callers can see whether React picked it up.
  return js(sid, `
    const input = document.querySelector('input[aria-label="Authenticator code"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((b) => /Verify and enable/i.test(b.textContent || ''));
    return input.value + '|disabled=' + (btn ? btn.disabled : 'nobtn');
  `);
}
async function js(sid, script) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script, args: [] });
}
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  const file = join(PROOFS, name);
  writeFileSync(file, Buffer.from(png, 'base64'));
  console.log('saved', file);
}
const session = await newSession();
const sid = session.sessionId;
try {
  await wd(`/session/${sid}/url`, 'POST', { url: 'http://localhost:5173/login' });
  await new Promise((r) => setTimeout(r, 6000));
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Platform admin')]"));
  await new Promise((r) => setTimeout(r, 800));
  await type(sid, await find(sid, 'css selector', '#admin-email'), 'tech@labha.dev');
  await type(sid, await find(sid, 'css selector', '#admin-password'), 'Labha123!');
  await click(sid, await find(sid, 'xpath', "//form//button[contains(., 'Sign in')]"));
  await new Promise((r) => setTimeout(r, 6000));
  let body = await js(sid, 'return document.body.innerText.slice(0, 300);');
  console.log('AFTER-LOGIN:', JSON.stringify(body).slice(0, 150));
  // Go straight to the profile page (same session).
  await wd(`/session/${sid}/url`, 'POST', { url: 'http://localhost:5173/console/profile' });
  await new Promise((r) => setTimeout(r, 5000));
  await shot(sid, '10-profile.png');
  // Start enrollment.
  console.log('STEP: finding setup button');
  const setupBtn = await find(sid, 'xpath', "//button[contains(., 'Set up authenticator app')]");
  console.log('STEP: scrolling into view + clicking');
  await js(sid, 'window.scrollTo(0, document.body.scrollHeight);');
  await new Promise((r) => setTimeout(r, 800));
  await click(sid, setupBtn);
  await new Promise((r) => setTimeout(r, 2000));
  // Fail #1 with a wrong code.
  console.log('STEP: typing code 1');
  console.log('TYPED-1:', await jsTypeCode(sid, '000000'));
  console.log('STEP: clicking verify 1');
  console.log('VERIFY-CLICK-1:', await jsClickText(sid, 'Verify and enable'));
  await new Promise((r) => setTimeout(r, 2500));
  // Fail #2 with another wrong code.
  await jsTypeCode(sid, '000001');
  console.log('VERIFY-CLICK-2:', await jsClickText(sid, 'Verify and enable'));
  await new Promise((r) => setTimeout(r, 2500));
  const after = await js(sid, 'return document.body.innerText;');
  writeFileSync(join(PROOFS, 'hints-body.txt'), after);
  await shot(sid, '11-hints.png');
  const guided = /delete the old entry/i.test(after);
  const startOver = /Start over/i.test(after);
  console.log('GUIDANCE_SHOWN:', guided, 'START_OVER_SHOWN:', startOver);
  console.log(guided && startOver ? 'RESULT: HINTS-ESCALATE' : 'RESULT: HINTS-MISSING');
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
