// Instrumented run: wrap fetch BEFORE login, capture the exact
// /auth/mfa/status response body the UI gate sees.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const WD = 'http://localhost:4444/wd/hub';
const PROOFS = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'mfa-gate-test');
mkdirSync(PROOFS, { recursive: true });
async function wd(path, method = 'GET', body) {
  const res = await fetch(`${WD}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return json.value;
}
const elId = (el) => el['element-6066-11e4-a52e-4f735466cecf'];
async function newSession() {
  return wd('/session', 'POST', {
    capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--window-size=1280,900'] } } }
  });
}
async function find(sid, using, value, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { return await wd(`/session/${sid}/element`, 'POST', { using, value }); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('not found ' + value);
}
async function click(sid, el) { await wd(`/session/${sid}/element/${elId(el)}/click`, 'POST', {}); }
async function type(sid, el, text) {
  await wd(`/session/${sid}/element/${elId(el)}/clear`, 'POST', {});
  await wd(`/session/${sid}/element/${elId(el)}/value`, 'POST', { text });
}
async function js(sid, script) {
  return wd(`/session/${sid}/execute/sync`, 'POST', { script, args: [] });
}
const session = await newSession();
const sid = session.sessionId;
try {
  await wd(`/session/${sid}/url`, 'POST', { url: 'http://localhost:5173/login' });
  await new Promise((r) => setTimeout(r, 5000));
  await js(sid, `
    window.__mfaProbe = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = String(args[0] && (args[0].url || args[0]));
      const res = await origFetch(...args);
      if (url.includes('/auth/mfa/status')) {
        try {
          const clone = res.clone();
          const text = await clone.text();
          window.__mfaProbe.push({ url, status: res.status, body: text.slice(0, 300) });
        } catch (e) {
          window.__mfaProbe.push({ url, fetchError: String(e).slice(0, 200) });
        }
      }
      return res;
    };
    // axios uses XHR, not fetch — also wrap XHR.
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return origOpen.apply(this, arguments); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (b) {
      this.addEventListener('loadend', function () {
        if (String(this.__u || '').includes('/auth/mfa/status')) {
          try { window.__mfaProbe.push({ url: this.__u, status: this.status, body: String(this.responseText).slice(0, 300) }); }
          catch (e) { window.__mfaProbe.push({ url: this.__u, xhrError: String(e).slice(0, 200) }); }
        }
      });
      return origSend.apply(this, arguments);
    };
    return 'hooks-installed';
  `);
  await click(sid, await find(sid, 'xpath', "//button[contains(., 'Platform admin')]"));
  await new Promise((r) => setTimeout(r, 800));
  await type(sid, await find(sid, 'css selector', '#admin-email'), 'root@labha.dev');
  await type(sid, await find(sid, 'css selector', '#admin-password'), 'Labha123!');
  await click(sid, await find(sid, 'xpath', "//form//button[contains(., 'Sign in')]"));
  await new Promise((r) => setTimeout(r, 9000));
  const probe = await js(sid, 'return JSON.stringify(window.__mfaProbe);');
  writeFileSync(join(PROOFS, 'mfa-probe.json'), probe);
  console.log('PROBE:', probe);
  const body = await js(sid, 'return document.body.innerText.slice(0, 200);');
  console.log('BODY:', JSON.stringify(body));
} finally {
  await wd(`/session/${sid}`, 'DELETE').catch(() => {});
}
