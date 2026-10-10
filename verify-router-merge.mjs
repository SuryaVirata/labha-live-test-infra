import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'router-merge-check');
mkdirSync(PROOFS, { recursive: true });

async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.value;
}
async function newSession() {
  return wd('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:5173`] } } } });
}
async function pageInfo(sid) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script: `return { url: location.href, text: document.body.innerText.slice(0, 500) };`, args: [] });
}
async function shot(sid, name) {
  const png = await wd(`/session/${sid}/screenshot`, 'GET');
  writeFileSync(join(PROOFS, name), Buffer.from(png, 'base64'));
}

const routesToCheck = ['/login', '/onboarding/phone', '/dashboard'];
let sid;
const results = [];
try {
  const session = await newSession();
  sid = session.sessionId;
  for (const route of routesToCheck) {
    await wd(`/session/${sid}/url`, 'POST', { url: `http://${HOST}:5173${route}` });
    await new Promise(r => setTimeout(r, 6000));
    const info = await pageInfo(sid);
    const crashed = /application error|something went wrong|chunk failed|cannot read prop/i.test(info.text) || info.text.trim() === '';
    const name = `route-${route.replace(/\//g, '_')}.png`;
    await shot(sid, name);
    results.push({ route, finalUrl: info.url, crashed, textPreview: info.text.slice(0, 200) });
    console.log(`${route} -> ${info.url} | crashed=${crashed}`);
  }
  writeFileSync(join(PROOFS, 'results.json'), JSON.stringify(results, null, 2));
} finally {
  if (sid) await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
