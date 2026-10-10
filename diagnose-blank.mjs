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
  const session = await wd('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } } });
  sid = session.sessionId;

  // Install an error collector BEFORE navigating
  await wd(`/session/${sid}/url`, 'POST', { url: `http://${HOST}:5173/login` });
  await new Promise(r => setTimeout(r, 4000));

  const diag = await wd(`/session/${sid}/execute/sync`, 'POST', {
    script: `
      return {
        readyState: document.readyState,
        rootHtml: document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 300) : 'NO #root ELEMENT',
        bodyChildCount: document.body.children.length,
        title: document.title
      };
    `,
    args: []
  });
  console.log(JSON.stringify(diag, null, 2));
} finally {
  if (sid) await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
