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

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:3000`] } } }
});
const sessionId = session.sessionId;
try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9888999111` });
  await new Promise((r) => setTimeout(r, 2000));
  const resendBtn = await findEl(sessionId, 'xpath', "//button[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'RESEND')]");
  await wd(`/session/${sessionId}/element/${elId(resendBtn)}/click`, 'POST', {});
  await new Promise((r) => setTimeout(r, 2500));
  const text = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: 'return document.body.innerText;', args: [] });
  console.log('After manual Resend click:\n', text);
  const perf = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `return performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('/api/'));`, args: [] });
  console.log('API calls observed:', JSON.stringify(perf));
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
