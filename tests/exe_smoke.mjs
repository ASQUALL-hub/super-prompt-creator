// End-to-end smoke test of the real SuperPromptCreator.exe against the mock
// Gemini API. The app runs with --test: off-screen, unfocused, no taskbar
// button, separate data/WebView2/credential profile. Driven over CDP.
// Usage: node tests/exe_smoke.mjs [path\to\SuperPromptCreator.exe] [screenshot-dir]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const EXE = process.argv[2] || path.join(ROOT, 'src-tauri', 'target', 'release', 'SuperPromptCreator.exe');
const SHOTS = process.argv[3] || ROOT;
const CDP_PORT = 9341;
const API_PORT = 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`); };

function foreground() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tests', 'fg.ps1')], { encoding: 'utf8' }).trim();
  } catch { return '?'; }
}
function credList() {
  let out = '';
  try { out = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
  return out.split(/\r?\n/).filter((l) => /SuperPromptCreator/.test(l)).join('\n');
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { return []; }
}

class Cdp {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expr, timeoutMs = 30000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ result: { result: { value: '__timeout__' } } })),
    ]);
    if (r.result && r.result.exceptionDetails) return { __exception: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const before = foreground();
console.log(`foreground before launch: ${before}`);
const api = spawn('python', [path.join(ROOT, 'tests', 'mock_gemini_server.py'), '--port', String(API_PORT)], { stdio: 'ignore' });
await sleep(800);
const app = spawn(EXE, ['--test', '--remote-debug-port', String(CDP_PORT)], {
  env: { ...process.env, SPC_API_BASE: `http://127.0.0.1:${API_PORT}/v1beta` },
  stdio: 'ignore',
});
let main;
try {
  let t = [];
  for (let i = 0; i < 60 && !t.find((x) => x.type === 'page' && x.url.startsWith('http://tauri.localhost')); i++) { await sleep(500); t = await targets(); }
  const page = t.find((x) => x.type === 'page' && x.url.startsWith('http://tauri.localhost'));
  check('app window starts and loads its UI', page, t.map((x) => x.url));
  if (!page) throw new Error('no page');
  main = new Cdp(page.webSocketDebuggerUrl);
  await main.open();
  for (let i = 0; i < 40; i++) { if (await main.eval("!!(window.__TAURI__ && document.querySelector('#account-chip .name'))")) break; await sleep(250); }
  const fgAfter = foreground();
  check('launch did not take the foreground window', fgAfter === before || !/Super Prompt/i.test(fgAfter), { before, fgAfter });

  const I = (cmd, args) => `window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})}).then(r => ({ ok: r }), e => ({ err: e }))`;

  const st0 = await main.eval(I('gemini_status'));
  check('fresh test profile starts unlinked', st0.ok && st0.ok.connected === false, st0);
  check('link overlay is shown when unlinked', await main.eval("!document.querySelector('#connect').hidden"), null);

  const bad = await main.eval(I('gemini_connect', { key: 'AIzaBAD00000000000000000000000000000000' }));
  check('bad key -> friendly "auth" error', bad.err && bad.err.kind === 'auth' && /isn't valid/.test(bad.err.message), bad);
  const junk = await main.eval(I('gemini_connect', { key: 'hello' }));
  check('non-key text is refused before any request', junk.err && /doesn't look like an API key/.test(junk.err.message), junk);

  const good = await main.eval(I('gemini_connect', { key: '  "AIzaGOOD0000000000000000000000000000000"  ' }));
  check('good key links and returns the model list', good.ok && good.ok.masked === 'AIza••••••••0000' && good.ok.models.length === 5, good);
  check('key saved in Windows Credential Manager', /SuperPromptCreator-test\/gemini-api-key/.test(credList()), credList());
  const st1 = await main.eval(I('gemini_status'));
  check('status reports linked with a masked key only', st1.ok && st1.ok.connected && !/GOOD0000000000000/.test(JSON.stringify(st1)), st1);

  const gen = await main.eval(I('gemini_generate', { model: 'gemini-2.5-flash', body: { contents: [{ role: 'user', parts: [{ text: 'x' }] }], generationConfig: { responseMimeType: 'application/json' } } }));
  check('generateContent (questions JSON) works', gen.ok && /current level/.test(JSON.stringify(gen.ok)), gen);
  const badModel = await main.eval(I('gemini_generate', { model: '../../evil', body: {} }));
  check('model names that could change the URL are refused', badModel.err && badModel.err.kind === 'model', badModel);

  const streamExpr = (text, cancelAfterMs) => `(async () => {
    const T = window.__TAURI__.core; const evs = []; let done;
    const finished = new Promise(r => done = r);
    const ch = new T.Channel(); ch.onmessage = (e) => { evs.push(e); if (e.type === 'done' || e.type === 'error') done(); };
    const p = T.invoke('gemini_stream', { requestId: 777, model: 'gemini-2.5-flash', body: { contents: [{ role: 'user', parts: [{ text: ${JSON.stringify(text)} }] }] }, onEvent: ch });
    ${cancelAfterMs ? `setTimeout(() => T.invoke('gemini_cancel', { requestId: 777 }), ${cancelAfterMs});` : ''}
    await Promise.race([finished, new Promise(r => setTimeout(r, 20000))]);
    await p.catch(() => {});
    return { text: evs.filter(e => e.type === 'delta').map(e => e.text).join(''), deltas: evs.filter(e => e.type === 'delta').length, last: evs[evs.length - 1] };
  })()`;
  const s1 = await main.eval(streamExpr('hello'));
  check('streaming delivers the full text in many deltas', s1.deltas > 5 && s1.text.includes('¡vamos! ✨') && s1.text.includes('Title: Mock Spanish Plan'), { deltas: s1.deltas, tail: s1.text && s1.text.slice(-60) });
  check('stream ends with STOP + usage', s1.last && s1.last.type === 'done' && s1.last.finishReason === 'STOP' && s1.last.usage && s1.last.usage.totalTokenCount === 140, s1.last);
  const s2 = await main.eval(streamExpr('#slow please', 700));
  check('Stop cancels a running stream', s2.last && s2.last.type === 'done' && s2.last.finishReason === 'CANCELLED' && s2.deltas < 200, { last: s2.last, deltas: s2.deltas });
  const s3 = await main.eval(streamExpr('#rate'));
  check('rate limit -> "quota" error with the wait time', s3.last && s3.last.type === 'error' && s3.last.kind === 'quota' && /21 seconds/.test(s3.last.message), s3.last);

  const w = await main.eval(I('store_write', { name: 'settings', data: '{"sendMode":"insert"}' }));
  const r = await main.eval(I('store_read', { name: 'settings' }));
  check('settings file round-trips', w.ok === null && r.ok === '{"sendMode":"insert"}', { w, r });
  const evil = await main.eval(I('store_write', { name: '..\\..\\evil', data: '{}' }));
  check('store refuses unknown file names', evil.err, evil);
  await main.eval(I('store_write', { name: 'settings', data: '{}' }));

  // ---- the real UI flow, as a person would do it
  await main.eval('location.reload()');
  await sleep(1500);
  for (let i = 0; i < 40; i++) { if (await main.eval("!!(window.__TAURI__ && document.querySelector('#account-chip.on'))")) break; await sleep(250); }
  check('after reload the app is linked (chip shows a model)', await main.eval("document.querySelector('#account-chip').textContent"), null);
  await main.eval(`(() => { const ta = document.querySelector('#idea'); ta.value = 'Plan a 3-month study schedule to learn Spanish'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (!document.querySelector('#opt-ask').checked) document.querySelector('#opt-ask').click(); document.querySelector('#go').click(); })()`);
  let qn = 0;
  for (let i = 0; i < 40 && !qn; i++) { await sleep(250); qn = await main.eval("document.querySelectorAll('.q-card').length"); }
  check('quick questions appear (from Gemini JSON)', qn === 2, qn);
  await main.eval("document.querySelector('.q-card .chip').click(); document.querySelector('#iv-go').click()");
  let done = false;
  for (let i = 0; i < 60 && !done; i++) { await sleep(250); done = await main.eval("!!document.querySelector('.prompt-view') && !document.querySelector('.prompt-view .caret') && !document.querySelector('.prompt-view .skeleton') && document.querySelector('.title-input').value === 'Mock Spanish Plan'"); }
  check('super prompt streams into the result view with its title', done, await main.eval("document.querySelector('.title-input') && document.querySelector('.title-input').value"));
  check('blank detected and offered as an input', await main.eval("!!document.querySelector('[data-blank=\"CURRENT_LEVEL\"]')"), null);
  const shot = await main.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    const f = path.join(SHOTS, 'exe-result.png');
    writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${f}`);
  }
  const log = await (await fetch(`http://127.0.0.1:${API_PORT}/__log`)).json();
  const posts = log.filter((x) => x.method === 'POST');
  check('API key travels only in the x-goog-api-key header', log.filter((x) => x.method).every((x) => !x.query_has_key) && posts.every((x) => x.key.startsWith('AIzaGOOD')), log.slice(0, 2));
  const lastCreate = posts.filter((x) => x.path.includes('stream')).pop();
  check('create request carries the system instruction + answers', lastCreate && lastCreate.body.systemInstruction && /Super Prompt Creator/.test(JSON.stringify(lastCreate.body.systemInstruction)) && /My answers to your questions/.test(JSON.stringify(lastCreate.body.contents)), lastCreate && Object.keys(lastCreate.body));
  let lib = null;
  for (let i = 0; i < 20 && !(lib && lib.includes('Mock Spanish Plan')); i++) { await sleep(250); lib = (await main.eval(I('store_read', { name: 'library' }))).ok; }
  check('prompt auto-saved to the library file', lib && lib.includes('Mock Spanish Plan'), lib && lib.slice(0, 80));

  // ---- Pages in the site windows must not be able to use the app's commands
  const st0s = await main.eval(I('sites_status'));
  check('fresh profile: signed in to no AI site', st0s.ok && !st0s.ok.gemini && !st0s.ok.chatgpt && !st0s.ok.claude, st0s);
  const badSite = await main.eval(I('chat_send', { site: 'evil', text: 'x', autoSend: false }));
  check('unknown sites are refused', badSite.err && /Unknown site/.test(String(badSite.err)), badSite);
  const tryFromPage = (cdp) => cdp.eval(`(async () => {
    const T = window.__TAURI__ || (window.__TAURI_INTERNALS__ && { core: { invoke: window.__TAURI_INTERNALS__.invoke } });
    if (!T) return { blocked: 'no bridge' };
    const tries = {};
    for (const [cmd, args] of [['gemini_status', {}], ['gemini_models', {}], ['store_read', { name: 'library' }], ['clipboard_write', { text: 'pwned' }], ['sites_status', {}], ['chat_send', { site: 'claude', text: 'x', autoSend: true }]]) {
      tries[cmd] = await T.core.invoke(cmd, args).then(r => ({ leaked: r }), e => ({ refused: String(e && e.message || e) }));
    }
    return tries;
  })()`);
  for (const [site, hostRe] of [['gemini', /google\./], ['chatgpt', /chatgpt\.com|openai\.com/]]) {
    const opened = await main.eval(I('site_open', { target: site }));
    check(`${site} window opens`, opened.ok === null, opened);
    let pt;
    for (let i = 0; i < 40 && !pt; i++) { await sleep(500); pt = (await targets()).find((x) => x.type === 'page' && hostRe.test(x.url)); }
    check(`${site} window loads the site`, pt, (await targets()).map((x) => x.url));
    if (!pt) continue;
    const pc = new Cdp(pt.webSocketDebuggerUrl);
    await pc.open();
    await sleep(1500);
    const attempt = await tryFromPage(pc);
    const refusedAll = attempt && (attempt.blocked || Object.values(attempt).every((v) => v.refused));
    check(`the ${site} page cannot call the app (key, models, library, clipboard, sending)`, refusedAll, attempt);
    if (site === 'chatgpt') {
      // Sign-in detection + sign-out, with a fake session cookie in this throwaway profile.
      await pc.eval(`document.cookie = '__Secure-next-auth.session-token=spc-test; Secure; Path=/; SameSite=Lax'`);
      let on;
      for (let i = 0; i < 10 && !(on && on.ok && on.ok.chatgpt); i++) { await sleep(300); on = await main.eval(I('sites_status')); }
      check('a ChatGPT session cookie counts as signed in', on.ok && on.ok.chatgpt && !on.ok.claude, on);
      const out = await main.eval(I('site_signout', { site: 'chatgpt' }));
      const after = await main.eval(I('sites_status'));
      let stillOpen = true;
      for (let i = 0; i < 20 && stillOpen; i++) { await sleep(250); stillOpen = (await targets()).some((x) => /chatgpt\.com|openai\.com/.test(x.url)); }
      check('Sign out of ChatGPT deletes its cookies and closes its window', out.ok >= 1 && after.ok && !after.ok.chatgpt && !stillOpen, { out, after, stillOpen });
    }
    pc.close();
    await main.eval(I('site_close', { target: site }));
  }

  const dis = await main.eval(I('gemini_disconnect'));
  check('unlink removes the key from Credential Manager', dis.ok === null && !/SuperPromptCreator-test/.test(credList()), credList());
} catch (e) {
  check('test run finished without crashing', false, String(e && e.stack || e));
} finally {
  if (main) main.close();
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { api.kill(); } catch { /* ignore */ }
  for (const t of ['SuperPromptCreator-test/gemini-api-key', 'LegacyGeneric:target=SuperPromptCreator-test/gemini-api-key']) {
    try { execFileSync('cmdkey', [`/delete:${t}`], { stdio: 'ignore' }); } catch { /* not there */ }
  }
  await sleep(2500);
  const roaming = path.join(process.env.APPDATA, 'com.superprompt.creator');
  const local = path.join(process.env.LOCALAPPDATA, 'com.superprompt.creator');
  for (const p of [path.join(roaming, 'test-profile'), path.join(local, 'EBWebView-test')]) {
    try { rmSync(p, { recursive: true, force: true }); } catch (e) { console.log(`cleanup: could not remove ${p}: ${e.message}`); }
  }
  for (const p of [roaming, local]) { try { if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true }); } catch { /* ignore */ } }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
