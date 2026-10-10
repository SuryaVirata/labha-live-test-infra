// Real browser test for the unified-login feature. Drives the Chromium in
// labha-live-test-infra's `browser` service over WebDriver. No mocked
// network. The page and the API are the ones running on this machine.
//
// Usage: node unified-login-test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
const DASHBOARD_URL = `http://${HOST}:5174/login`;
const NEW_PHONE = String(Math.floor(9000000000 + Math.random() * 999999999)).slice(0, 10);
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs');

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
            `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:5174`
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

async function shot(sessionId, name) {
  const png = await wd(`/session/${sessionId}/screenshot`, 'GET');
  const file = join(PROOFS, name);
  writeFileSync(file, Buffer.from(png, 'base64'));
  console.log('saved', file);
}

async function bodyText(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText.slice(0, 1000);',
    args: []
  });
}

console.log('Testing with brand-new phone number:', NEW_PHONE);

const session = await newSession();
const sessionId = session.sessionId;
console.log('WebDriver session:', sessionId);

try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: DASHBOARD_URL });
  await findEl(sessionId, 'css selector', '#login-phone');
  await shot(sessionId, 'unified-01-login-page.png');

  const phoneEl = await findEl(sessionId, 'css selector', '#login-phone');
  await wd(`/session/${sessionId}/element/${elId(phoneEl)}/value`, 'POST', { text: NEW_PHONE });
  await shot(sessionId, 'unified-02-phone-typed.png');
  const btnEl = await findEl(sessionId, 'xpath', "//button[contains(., 'Send OTP')]");
  await wd(`/session/${sessionId}/element/${elId(btnEl)}/click`, 'POST', {});

  await new Promise((r) => setTimeout(r, 3000));
  const midway = await bodyText(sessionId);
  await shot(sessionId, 'unified-03-after-send.png');
  console.log('After send click:', JSON.stringify(midway));

  const stillOnPhoneScreen = /couldn.t find an account/i.test(midway);
  const foundOtpBox = midway.includes('One-time code') || /code sent to/i.test(midway);

  console.log('\n=== UNIFIED LOGIN VERDICT (so far) ===');
  console.log(`Blocked with "no account" message: ${stillOnPhoneScreen} — want false -> ${stillOnPhoneScreen ? 'FAIL' : 'PASS'}`);
  console.log(`Proceeded straight to OTP screen: ${foundOtpBox} — want true -> ${foundOtpBox ? 'PASS' : 'FAIL'}`);

  if (!foundOtpBox) {
    console.log('Did not reach OTP screen; stopping here.');
    process.exitCode = 1;
  } else {
    await findEl(sessionId, 'css selector', '#login-otp', 20);
    const afterSend = await bodyText(sessionId);
    await shot(sessionId, 'unified-04-otp-screen.png');
    console.log('After send (OTP screen):', JSON.stringify(afterSend));

    const codeMatch = afterSend.match(/Dev code:\s*(\d+)/);
    if (!codeMatch) throw new Error('OTP screen opened but no dev code was shown');

    const otpEl = await findEl(sessionId, 'css selector', '#login-otp');
    await wd(`/session/${sessionId}/element/${elId(otpEl)}/clear`, 'POST', {});
    await wd(`/session/${sessionId}/element/${elId(otpEl)}/value`, 'POST', { text: codeMatch[1] });
    const verifyEl = await findEl(sessionId, 'xpath', "//button[contains(., 'Verify')]");
    await wd(`/session/${sessionId}/element/${elId(verifyEl)}/click`, 'POST', {});

    await new Promise((r) => setTimeout(r, 2500));
    const afterVerify = await bodyText(sessionId);
    await shot(sessionId, 'unified-05-after-verify.png');
    console.log('After verify:', JSON.stringify(afterVerify));

    const currentUrl = await wd(`/session/${sessionId}/url`, 'GET');
    console.log('URL after verify:', currentUrl);

    const reachedOnboarding = /onboarding|business|store/i.test(currentUrl) || /legal business name|set up your business|onboarding/i.test(afterVerify);

    console.log('\n=== FINAL UNIFIED LOGIN VERDICT ===');
    console.log(`Blocked with "no account": ${stillOnPhoneScreen} — want false -> ${stillOnPhoneScreen ? 'FAIL' : 'PASS'}`);
    console.log(`Got a real OTP and verified: true — PASS`);
    console.log(`Landed on onboarding after verify (brand-new, no merchant yet): ${reachedOnboarding} — want true -> ${reachedOnboarding ? 'PASS' : 'FAIL'}`);
    if (stillOnPhoneScreen || !reachedOnboarding) process.exitCode = 1;
  }
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
