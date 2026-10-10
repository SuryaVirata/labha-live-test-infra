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
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9123123124` });
  await new Promise((r) => setTimeout(r, 2500));

  const otpEl = await findEl(sessionId, 'css selector', '#otp');
  await wd(`/session/${sessionId}/element/${elId(otpEl)}/value`, 'POST', { text: 'a1b2c3' });
  await new Promise((r) => setTimeout(r, 300));
  const val = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: "return document.getElementById('otp').value;", args: [] });
  console.log('OTP input value after typing a1b2c3 (React onChange should strip letters -> expect "123"):', JSON.stringify(val));

  const reactRoot = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    const el = document.getElementById('otp');
    const keys = Object.keys(el).filter(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'));
    return { hasReactProps: keys.length > 0, keys };
  `, args: [] });
  console.log('React internal props attached to #otp element:', JSON.stringify(reactRoot));

  const hydrationCheck = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    return {
      nextDataPresent: !!document.getElementById('__NEXT_DATA__'),
      bodyHasHydrated: document.documentElement.getAttribute('data-hydrated') || null,
      reactVersion: window.React ? window.React.version : 'no global React',
      scriptsCount: document.scripts.length,
    };
  `, args: [] });
  console.log('Hydration env check:', JSON.stringify(hydrationCheck));
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
