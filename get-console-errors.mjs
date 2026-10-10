const WD = 'http://localhost:4444/wd/hub';
const HOST = '172.21.0.1';

async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.value;
}

let sid;
try {
  const session = await wd('/session', 'POST', {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': { args: ['--window-size=1280,900'] },
        'goog:loggingPrefs': { browser: 'ALL' }
      }
    }
  });
  sid = session.sessionId;

  await wd(`/session/${sid}/url`, 'POST', { url: `http://${HOST}:5173/login` });
  await new Promise(r => setTimeout(r, 4000));

  const logs = await wd(`/session/${sid}/se/log`, 'POST', { type: 'browser' }).catch(async () => {
    // Fallback to legacy endpoint
    return wd(`/session/${sid}/log`, 'POST', { type: 'browser' });
  });
  for (const entry of logs) {
    console.log(`[${entry.level}]`, entry.message);
  }
} finally {
  if (sid) await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
