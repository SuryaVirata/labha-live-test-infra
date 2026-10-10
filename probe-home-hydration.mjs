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
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev` });
  await new Promise((r) => setTimeout(r, 4000));
  const check = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    const all = document.querySelectorAll('*');
    let hydrated = 0;
    for (const el of all) {
      if (Object.keys(el).some(k => k.startsWith('__reactFiber'))) { hydrated++; }
    }
    return { hydratedElementCount: hydrated, totalElements: all.length, readyState: document.readyState };
  `, args: [] });
  console.log('Homepage hydration check:', JSON.stringify(check));
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
