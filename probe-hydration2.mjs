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

const session = await wd('/session', 'POST', {
  capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:3000`] } } }
});
const sessionId = session.sessionId;
try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9123123126` });

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const check = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
      const otp = document.getElementById('otp');
      const keys = otp ? Object.keys(otp).filter(k => k.startsWith('__react')) : [];
      return { t: Date.now(), hasReact: keys.length > 0, readyState: document.readyState, resourceCount: performance.getEntriesByType('resource').length };
    `, args: [] });
    console.log(`t=${(i+1)*2}s`, JSON.stringify(check));
    if (check.hasReact) { console.log('HYDRATED!'); break; }
  }
  const otpVal = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    const el = document.getElementById('otp');
    el.focus();
    return 'ready';
  `, args: [] });
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
