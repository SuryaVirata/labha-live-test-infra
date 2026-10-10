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
  await new Promise((r) => setTimeout(r, 3000));
  const check = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    return {
      nextFType: typeof window.__next_f,
      nextFLength: window.__next_f ? window.__next_f.length : null,
      hasWebpackChunk: typeof window.webpackChunk_N_E !== 'undefined' || Object.keys(window).some(k => k.startsWith('webpackChunk') || k.startsWith('__TURBOPACK')),
      turbopackKeys: Object.keys(window).filter(k => k.toLowerCase().includes('turbopack') || k.toLowerCase().includes('webpack')),
      allScriptsLoaded: Array.from(document.scripts).every(s => !s.src || s.src),
      lastScriptSrc: document.scripts[document.scripts.length-1]?.src,
      errorEventCount: window.__errCount || 0,
    };
  `, args: [] });
  console.log(JSON.stringify(check, null, 2));

  // attach error listener retroactively won't catch past errors, but check onerror firing on window
  const err = await wd(`/session/${sessionId}/execute/sync`, 'POST', { script: `
    return window.onerror ? 'has onerror handler' : 'no onerror handler';
  `, args: [] });
  console.log('onerror handler:', err);
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
