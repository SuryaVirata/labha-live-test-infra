// Probe: does the Vite-served page silently reload under us?
const WD = 'http://localhost:4444/wd/hub';
const DASH = 'http://localhost:5173';
async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return json.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = await wd('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'chrome' } } });
const sid = s.sessionId;
await wd(`/session/${sid}/url`, 'POST', { url: `${DASH}/login` });
await sleep(4000);
await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'window.__marker = { at: Date.now() }; return 1;', args: [] });
for (let i = 1; i <= 5; i++) {
  await sleep(20000);
  const r = await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return { marker: window.__marker ? Date.now() - window.__marker.at : null, href: location.href };', args: [] });
  console.log(`t=${i * 20}s`, JSON.stringify(r));
}
// DOM stability check too
const r2 = await wd(`/session/${sid}/execute/sync`, 'POST', { script: 'return { href: location.href, hasForm: !!document.querySelector("#login-phone") };', args: [] });
console.log('final', JSON.stringify(r2));
await wd(`/session/${sid}`, 'DELETE').catch(() => {});
