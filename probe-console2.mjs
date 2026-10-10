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
  capabilities: {
    alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900', `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:3000`] } }
  },
  desiredCapabilities: { browserName: 'chrome', 'goog:loggingPrefs': { browser: 'ALL' } }
});
const sessionId = session.sessionId;
try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: `http://${HOST}:3000/store/labha-dev/verify?type=login&mobile=9123123127` });
  await new Promise((r) => setTimeout(r, 8000));
  const logs = await wd(`/session/${sessionId}/log`, 'POST', { type: 'browser' });
  for (const l of logs) {
    console.log(`[${l.level}] ${l.message}`.slice(0, 500));
  }
  console.log('--- total log entries:', logs.length);
} finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {});
}
