// Probe: does "Send to …" find and fill the real site's message box?
// Runs the EXE with --test (fresh, signed-out WebView2 profile, off-screen),
// sends with autoSend=false so nothing is ever submitted, then reports what the
// page looks like. Usage:
//   node tests/chat_inject_probe.mjs <gemini|chatgpt|claude> [exe] [screenshot-dir]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SITE = process.argv[2] || 'gemini';
const EXE = process.argv[3] || path.join(ROOT, 'src-tauri', 'target', 'release', 'SuperPromptCreator.exe');
const SHOTS = process.argv[4] || ROOT;
const PORT = 9342;
const HOSTS = { gemini: /gemini\.google\.com|accounts\.google/, chatgpt: /chatgpt\.com|openai\.com/, claude: /claude\.ai/ };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
  const evalv = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
  return { send, eval: evalv, close: () => ws.close() };
}

const app = spawn(EXE, ['--test', '--remote-debug-port', String(PORT)], { stdio: 'ignore' });
try {
  let page;
  for (let i = 0; i < 60 && !page; i++) { await sleep(500); page = (await targets()).find((x) => x.type === 'page' && x.url.startsWith('http://tauri.localhost')); }
  if (!page) throw new Error('app did not start');
  const main = await cdp(page.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) { if (await main.eval('!!window.__TAURI__')) break; await sleep(250); }
  const TEXT = 'Super Prompt Creator test (not sent)\nLine two of the prompt.';
  const r = await main.eval(`window.__TAURI__.core.invoke('chat_send', { site: ${JSON.stringify(SITE)}, text: ${JSON.stringify(TEXT)}, autoSend: false }).then(() => 'ok', e => 'ERR ' + e)`);
  console.log('chat_send:', r);
  let g;
  for (let i = 0; i < 40 && !g; i++) { await sleep(500); g = (await targets()).find((x) => x.type === 'page' && HOSTS[SITE].test(x.url)); }
  if (!g) throw new Error(`no ${SITE} window`);
  const site = await cdp(g.webSocketDebuggerUrl);
  let state;
  for (let i = 0; i < 40; i++) {
    await sleep(750);
    state = await site.eval(`(() => {
      const box = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], #prompt-textarea, div.ProseMirror[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector('textarea');
      const send = document.querySelector('button.send-button, button[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]');
      return { url: location.href, title: document.title, box: box ? (box.tagName + '#' + box.id + '.' + (box.className || '').toString().slice(0, 50)) : null,
        boxText: box ? (box.innerText || box.value || '').slice(0, 120) : null,
        sendButton: send ? (send.getAttribute('aria-label') || send.getAttribute('data-testid') || send.id || send.className) : null,
        sendDisabled: send ? String(send.disabled || send.getAttribute('aria-disabled')) : null,
        toast: (document.getElementById('spc-toast') || {}).textContent || null };
    })()`);
    if (state && (state.toast || (state.boxText && state.boxText.includes('Line two')))) break;
  }
  console.log(JSON.stringify(state, null, 2));
  const shot = await site.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result) { const f = path.join(SHOTS, `${SITE}-probe.png`); writeFileSync(f, Buffer.from(shot.result.data, 'base64')); console.log('screenshot:', f); }
  site.close();
  main.close();
} catch (e) {
  console.log('probe error:', e.message);
} finally {
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  await sleep(2500);
  const roaming = path.join(process.env.APPDATA, 'com.superprompt.creator');
  const local = path.join(process.env.LOCALAPPDATA, 'com.superprompt.creator');
  for (const p of [path.join(roaming, 'test-profile'), path.join(local, 'EBWebView-test')]) { try { rmSync(p, { recursive: true, force: true }); } catch (e) { console.log('cleanup:', e.message); } }
  for (const p of [roaming, local]) { try { if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true }); } catch { /* ignore */ } }
}
