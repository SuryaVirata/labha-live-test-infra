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
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9123123125` });
  await new Promise((r) => setTimeout(r, 1500));

  const check = await wd(`/session/${sessionId}/execute/async`, 'POST', { script: `
    const callback = arguments[arguments.length - 1];
    const scripts = Array.from(document.scripts).map(s => s.src).filter(Boolean);
    Promise.all(scripts.slice(0, 6).map(src =>
      fetch(src).then(r => ({ src, status: r.status, ct: r.headers.get('content-type'), len: r.headers.get('content-length') }))
        .catch(e => ({ src, error: String(e) }))
    )).then(results => callback({ totalScripts: scripts.length, sample: results }));
  `, args: [] });
  console.log(JSON.stringify(check, null, 2));
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
