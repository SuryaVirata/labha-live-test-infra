// Recovery UI proof: MFA gate shows the recovery entry, panel opens;
// Root (AAL-2 via recovery code) sees the review page.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = 'localhost';
const URL = `http://${HOST}:5173/login`;
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-recovery-ui');
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
  const adminTab = await find(sid, 'xpath', "//button[contains(., 'Platform admin')]");
  await click(sid, adminTab);
  await new Promise((r) => setTimeout(r, 1000));
  const email = await find(sid, 'css selector', '#admin-email');
  await type(sid, email, 'root@labha.dev');
  const pass = await find(sid, 'css selector', '#admin-password');
  await type(sid, pass, 'Labha123!');
  const signin = await find(sid, 'xpath', "//button[contains(., 'Sign in')]");
  await click(sid, signin);

  // Wait for the MFA gate.
  let gate = '';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    gate = await bodyText(sid);
    if (gate.includes('Authenticator code') || gate.includes('authenticator')) break;
  }
  console.log('GATE-SEEN:', gate.includes('Lost your codes too?'));
  if (!gate.includes('Lost your codes too?')) throw new Error('recovery entry link missing at MFA gate');
  await shot(sid, '01-gate-with-recovery-link.png');

  const helpLink = await find(sid, 'xpath', "//button[contains(., 'Lost your codes too?')]");
  await click(sid, helpLink);
  await new Promise((r) => setTimeout(r, 1500));
  const panel = await bodyText(sid);
  console.log('PANEL-SEEN:', panel.includes('Email me a verification code'));
  if (!panel.includes('Email me a verification code')) throw new Error('recovery panel did not open');
  await shot(sid, '02-recovery-panel.png');

  // Back to code entry, use a recovery code to reach AAL-2 console.
  const back = await find(sid, 'xpath', "//button[contains(., 'Back to code entry')]");
  await click(sid, back);
  await new Promise((r) => setTimeout(r, 1000));
  const useCode = await find(sid, 'xpath', "//button[contains(., 'Use a recovery code')]");
  await click(sid, useCode);
  await new Promise((r) => setTimeout(r, 1000));
  // NOTE: single-use code — update to a fresh unused root code every run.
  const codeInput = await find(sid, 'css selector', '#admin-mfa-code');
  await type(sid, codeInput, 'WFR9-BGYE');
  const verify = await find(sid, 'xpath', "//button[contains(., 'Verify')]");
  await click(sid, verify);
  // Wait for the console shell AND for step-up tokens to settle: the
  // recovery call swaps the access token, then re-reads /me. Navigating
  // before that completes fires authed requests with the pre-step-up
  // (AAL-1) token and the AAL-2-gated review API 403s — a test artifact,
  // not an app bug. Poll for a console-only marker first.
  // Poll for a console-ONLY marker. 'Merchants' also appears in the login
  // page marketing copy and caused a false-positive console detection.
  let consoleReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const t = await bodyText(sid);
    if (t.includes('Internal console')) { consoleReady = true; break; }
  }
  if (!consoleReady) throw new Error('console never appeared after recovery-code login');
  await new Promise((r) => setTimeout(r, 4000));
  const after = await bodyText(sid);
  console.log('CONSOLE-SEEN:', after.slice(0, 120));

  // Review page via IN-APP navigation (SPA link click, no full reload: a
  // reload drops the in-memory AAL-2 token and the refresh cycle only
  // re-mints AAL-1, so AAL-2-gated APIs 403 after reload — by design).
  const navLink = await find(sid, 'xpath', "//a[contains(., 'MFA recovery')]");
  await click(sid, navLink);
  await new Promise((r) => setTimeout(r, 4000));
  const review = await bodyText(sid);
  console.log('REVIEW-SEEN:', review.includes('MFA recovery requests') && !review.includes('Something went wrong'));
  if (!review.includes('MFA recovery requests')) throw new Error('review page missing');
  if (review.includes('Something went wrong')) throw new Error('review queue query failed');
  await shot(sid, '03-review-page.png');
  console.log('UI-PROOF-DONE');
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
