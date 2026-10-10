const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
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
function elId(el) { return el['element-6066-11e4-a52e-4f735466cecf']; }
async function findEl(sessionId, using, value, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sessionId}/element`, 'POST', { using, value }); }
    catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  throw new Error(`element not found: ${using}=${value}`);
}
async function text(sessionId) {
  return wd(`/session/${sessionId}/execute/sync`, 'POST', { script: 'return document.body.innerText;', args: [] });
}

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:3000`] } } }
});
const sessionId = session.sessionId;
try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9123123123` });
  await new Promise((r) => setTimeout(r, 2500)); // let hydration settle
  const before = await text(sessionId);
  console.log('BEFORE click, contains RESEND CODE:', before.includes('RESEND CODE'));

  const resendBtn = await findEl(sessionId, 'xpath', "//button[contains(., 'Resend')]");
  await wd(`/session/${sessionId}/element/${elId(resendBtn)}/click`, 'POST', {});

  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await text(sessionId);
    const cooldownMatch = t.match(/Resend in (\d+)s/);
    const devMatch = t.match(/Developer OTP[\s\S]{0,30}/i);
    const resendMsgMatch = t.match(/(A new code was sent\.|Could not resend code\.|[A-Za-z ]*error[A-Za-z .]*)/i);
    console.log(`t=${(i+1)*0.5}s cooldown=${cooldownMatch ? cooldownMatch[1] : 'none'} devOtpShown=${!!devMatch} resendLine=${resendMsgMatch ? resendMsgMatch[0] : 'none'}`);
  }
  const final = await text(sessionId);
  console.log('\nFINAL TEXT:\n', final);
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
