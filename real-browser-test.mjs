// Real browser test. Drives the Chromium in labha-live-test-infra's
// `browser` service over WebDriver. No mocked network. The page and the
// API are the ones running on this machine.
//
// Usage: node real-browser-test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
const DASHBOARD_URL = `http://${HOST}:5175/login`;
const PHONES = ['9633000001', '9633000002', '9633000003', '9633000004', '9633000005'];
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'dashboard');

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
            `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:5175`
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
  return file;
}

async function bodyText(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: 'return document.body.innerText;',
    args: []
  });
}

async function pageInfo(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', {
    script: `return {
      url: location.href,
      title: document.title,
      text: document.body.innerText,
      hasOtp: !!document.querySelector('#login-otp'),
      hasPhone: !!document.querySelector('#login-phone'),
      hasGoogle: /google/i.test(document.body.innerText),
      hasFacebook: /facebook/i.test(document.body.innerText),
      hasAccountNotFound: /isn't connected|couldn.t find an account/i.test(document.body.innerText)
    };`,
    args: []
  });
}

function writeText(name, content) {
  const file = join(PROOFS, name);
  writeFileSync(file, content, 'utf8');
  console.log('saved', file);
  return file;
}

function wrongBranch(info) {
  return (
    info.hasGoogle ||
    info.hasFacebook ||
    /isn't connected to your existing account/i.test(info.text || '')
  );
}

const results = [];
let sessionId = null;

try {
  for (let i = 0; i < PHONES.length; i++) {
    const phone = PHONES[i];
    const n = String(i + 1).padStart(2, '0');
    const isFirst = i === 0;
    console.log(`\n=== Phone ${phone} (${n}) ===`);

    // Fresh browser session per phone so a prior verify cannot keep us signed in.
    if (sessionId) {
      await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
      sessionId = null;
    }
    const session = await newSession();
    sessionId = session.sessionId;
    console.log('WebDriver session:', sessionId);

    await wd(`/session/${sessionId}/url`, 'POST', {
      url: `${DASHBOARD_URL}?n=${phone}`
    });
    await findEl(sessionId, 'css selector', '#login-phone', 40);

    const beforeInfo = await pageInfo(sessionId);
    if (wrongBranch(beforeInfo)) {
      await shot(sessionId, `${n}-${phone}-WRONG-BRANCH.png`);
      writeText(
        `${n}-${phone}-result.txt`,
        `FAIL: wrong branch / social login UI\nphone: ${phone}\nurl: ${beforeInfo.url}\n\n${beforeInfo.text}`
      );
      throw new Error('Wrong branch: Google/Facebook or account-not-connected message visible. Stop.');
    }

    const phoneEl = await findEl(sessionId, 'css selector', '#login-phone');
    await wd(`/session/${sessionId}/element/${elId(phoneEl)}/clear`, 'POST', {}).catch(() => {});
    await wd(`/session/${sessionId}/element/${elId(phoneEl)}/value`, 'POST', { text: phone });
    await shot(sessionId, `${n}-${phone}-before-send.png`);

    const btnEl = await findEl(sessionId, 'xpath', "//button[contains(., 'Send OTP')]");
    await wd(`/session/${sessionId}/element/${elId(btnEl)}/click`, 'POST', {});

    await new Promise((r) => setTimeout(r, 3500));

    let afterInfo = await pageInfo(sessionId);
    await shot(sessionId, `${n}-${phone}-after-send.png`);

    if (wrongBranch(afterInfo)) {
      writeText(
        `${n}-${phone}-result.txt`,
        `FAIL: wrong branch after send\nphone: ${phone}\nurl: ${afterInfo.url}\n\n${afterInfo.text}`
      );
      throw new Error('Wrong branch after send. Stop.');
    }

    const otpAppeared =
      afterInfo.hasOtp &&
      /Code sent to/i.test(afterInfo.text) &&
      !afterInfo.hasAccountNotFound;

    const codeMatch = (afterInfo.text || '').match(/Dev code:\s*(\d+)/);
    const devCode = codeMatch ? codeMatch[1] : null;

    let verifyOutcome = 'skipped (not first number)';
    let verifyText = '';

    if (isFirst) {
      if (!otpAppeared || !devCode) {
        await shot(sessionId, `${n}-${phone}-verify-FAIL.png`);
        verifyOutcome = 'FAIL: OTP screen/dev code missing before verify';
      } else {
        // LoginPage already prefills #login-otp with the dev code — do not
        // append another type-in (WebDriver value appends, which corrupted OTP).
        const verifyEl = await findEl(sessionId, 'xpath', "//button[contains(., 'Verify')]");
        await wd(`/session/${sessionId}/element/${elId(verifyEl)}/click`, 'POST', {});
        await new Promise((r) => setTimeout(r, 3500));
        const afterVerify = await pageInfo(sessionId);
        verifyText = afterVerify.text || '';
        await shot(sessionId, `${n}-${phone}-after-verify.png`);

        const signedIn = /Signed in as \+919633000001/i.test(verifyText);
        const business =
          /legal business name|set up your business/i.test(verifyText);
        if (signedIn && business) {
          verifyOutcome = 'PASS: Signed in + legal business name';
        } else {
          verifyOutcome = 'FAIL: expected Signed in as +919633000001 and legal business name';
          await shot(sessionId, `${n}-${phone}-verify-FAIL.png`);
        }
      }
    }

    const resultBody = [
      `phone: ${phone}`,
      `normalized_expected: +91${phone}`,
      `otp_screen_appeared: ${otpAppeared}`,
      `dev_code: ${devCode ?? '(not shown)'}`,
      `url_after_send: ${afterInfo.url}`,
      `verify_outcome: ${verifyOutcome}`,
      '',
      '--- page text after send ---',
      afterInfo.text || '',
      '',
      verifyText ? '--- page text after verify ---' : '',
      verifyText || ''
    ].join('\n');

    writeText(`${n}-${phone}-result.txt`, resultBody);

    results.push({
      phone,
      otpAppeared,
      devCode,
      verifyOutcome
    });

    console.log(`OTP screen: ${otpAppeared ? 'YES' : 'NO'}; Dev code: ${devCode ?? 'n/a'}; ${verifyOutcome}`);

    if (!otpAppeared) {
      console.error(`OTP screen did not appear for ${phone}`);
      process.exitCode = 1;
    }
    if (isFirst && !/^PASS/.test(verifyOutcome)) {
      process.exitCode = 1;
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(
      `${r.phone}: OTP=${r.otpAppeared ? 'YES' : 'NO'} code=${r.devCode ?? '-'} verify=${r.verifyOutcome}`
    );
  }
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
