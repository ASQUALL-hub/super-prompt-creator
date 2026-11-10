import {
  TARGETS, TEXT_TYPES, IMAGE_MODELS, VIDEO_MODELS, DETAILS, REFINE_CHIPS, EXAMPLES, PLACEHOLDER_TEXT,
  createRequest, improveRequest, refineRequest, interviewRequest, splitOutput,
  placeholders, fillPlaceholders, prettyPlaceholder,
} from './prompts.js';
import { renderMarkdown, highlightPrompt } from './markdown.js';
import { icon, logo } from './icons.js';

// ------------------------------------------------------------------ bridge
const TAURI = window.__TAURI__;
const invoke = (cmd, args = {}) => TAURI.core.invoke(cmd, args);
const makeChannel = (fn) => {
  const c = new TAURI.core.Channel();
  c.onmessage = fn;
  return c;
};
function normErr(e) {
  if (e && typeof e === 'object' && e.message) return { kind: e.kind || 'other', message: String(e.message) };
  return { kind: 'other', message: String(e || 'Something went wrong.') };
}

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // trusted markup only (icons, escaped markdown)
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function ic(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

function fmtDate(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function fallbackTitle(idea) {
  const words = idea.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  const t = words.length > 60 ? words.slice(0, 57) + '…' : words;
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Untitled prompt';
}

function toast(msg, type = 'ok', ms = 2600) {
  const el = h('div', { class: `toast ${type}` }, ic(type === 'err' ? 'alert' : type === 'info' ? 'spark' : 'check'), h('span', { text: msg }));
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-body').replaceChildren(typeof body === 'string' ? h('p', { text: body }) : body);
    const row = $('#modal-actions');
    row.replaceChildren();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    const close = (v) => {
      m.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    for (const a of actions) row.append(h('button', { class: a.class || 'ghost', onclick: () => close(a.value) }, a.label));
    m.onclick = (e) => { if (e.target === m) close(null); };
    document.addEventListener('keydown', onKey, true);
    m.hidden = false;
    row.lastChild && row.lastChild.focus();
  });
}

// ------------------------------------------------------------------ state
const DEFAULT_DRAFT = {
  target: 'gemini', kind: 'auto', imageModel: 'gemini', videoModel: 'veo', detail: 'balanced',
  askFirst: true, blanks: true, examples: false, aiAsks: false,
};
const DEFAULT_SETTINGS = {
  model: '', imageModel: '', sendMode: 'send', draft: { ...DEFAULT_DRAFT },
  sitesOpened: { gemini: false, chatgpt: false, claude: false }, // has the user opened that site's window (and so had the chance to sign in)?
};

const S = {
  settings: structuredClone(DEFAULT_SETTINGS),
  library: [],
  models: [],
  account: { connected: false, masked: '' },
  sites: { gemini: false, chatgpt: false, claude: false }, // signed in inside the app?
  info: { version: '', test: false },
  view: 'create',
  mode: 'create',
  draft: { ...DEFAULT_DRAFT, idea: '' },
  stage: 'empty', // empty | interview-loading | interview | result | error
  session: null,
  interview: null,
  error: null,
  tab: 'prompt',
  editing: false,
  busy: null, // { type: 'interview' | 'generate' | 'test', token, requestId }
  libFilter: 'all',
  libQuery: '',
};
let genToken = 0;
let reqSeq = 1;
let R = null; // live references into the result view

const saveSettings = debounce(() => {
  invoke('store_write', { name: 'settings', data: JSON.stringify(S.settings) }).catch((e) => console.warn('settings', e));
}, 250);
const saveLibrary = debounce(() => {
  invoke('store_write', { name: 'library', data: JSON.stringify(S.library) })
    .catch((e) => toast(`Couldn't save your library: ${normErr(e).message}`, 'err', 6000));
}, 400);

function persistDraft() {
  const { idea, ...rest } = S.draft;
  S.settings.draft = rest;
  saveSettings();
}

// ------------------------------------------------------------------ models
const EXCLUDE = /(embed|tts|audio|live|veo|imagen|aqa|computer-use|robotics|learnlm|image|nano)/i;
const isPreview = (id) => /preview|exp/i.test(id);
const isAlias = (id) => /-latest$/i.test(id);
const modelVersion = (id) => { const m = id.match(/gemini-(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; };
const modelTier = (id) => (/lite/i.test(id) ? 1 : /flash/i.test(id) ? 2 : /pro|ultra/i.test(id) ? 3 : 0);
function modelSort(a, b) {
  return (isAlias(b.id) - isAlias(a.id))
    || (modelVersion(b.id) - modelVersion(a.id))
    || (modelTier(b.id) - modelTier(a.id))
    || (isPreview(a.id) - isPreview(b.id))
    || a.id.localeCompare(b.id);
}
const chatModels = (list) => list
  .filter((m) => /^gemini/i.test(m.id) && (m.methods || []).includes('generateContent') && !EXCLUDE.test(m.id))
  .sort(modelSort);
const imageModels = (list) => list
  .filter((m) => /^gemini/i.test(m.id) && /image/i.test(m.id) && (m.methods || []).includes('generateContent'))
  .sort(modelSort);
function pickDefaultModel(chat) {
  return chat.find((m) => m.id === 'gemini-flash-latest')
    || chat.find((m) => modelTier(m.id) === 2 && !isPreview(m.id) && !isAlias(m.id))
    || chat.find((m) => modelTier(m.id) === 2)
    || chat[0];
}
function modelName(id) {
  const m = S.models.find((x) => x.id === id);
  if (m) return m.displayName;
  if (!id) return 'Gemini';
  return id.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function modelLabel(m) {
  const tags = [];
  if (isAlias(m.id)) tags.push('always newest');
  else if (modelTier(m.id) === 3) tags.push('smartest');
  else if (modelTier(m.id) === 2) tags.push('fast');
  else if (modelTier(m.id) === 1) tags.push('fastest');
  if (isPreview(m.id)) tags.push('preview');
  return `${m.displayName}${tags.length ? ` — ${tags.join(', ')}` : ''}`;
}
function setModels(list) {
  S.models = Array.isArray(list) ? list : [];
  const chat = chatModels(S.models);
  if (chat.length && !chat.some((m) => m.id === S.settings.model)) S.settings.model = (pickDefaultModel(chat) || {}).id || '';
  const imgs = imageModels(S.models);
  if (S.settings.imageModel !== 'none' && !imgs.some((m) => m.id === S.settings.imageModel)) S.settings.imageModel = imgs[0] ? imgs[0].id : '';
  saveSettings();
  renderAccountChip();
  renderGoButton();
  if (S.view === 'settings') renderSettings();
}
async function loadModels() {
  try {
    setModels(await invoke('gemini_models'));
  } catch (e) {
    const err = normErr(e);
    if (err.kind === 'auth') toast(err.message, 'err', 7000);
    else toast(`Couldn't load your Gemini models: ${err.message}`, 'err', 5000);
  }
}

// ------------------------------------------------------------------ account
function renderAccountChip() {
  const chip = $('#account-chip');
  chip.className = `account-chip ${S.account.connected ? 'on' : 'off'}`;
  chip.replaceChildren(
    h('span', { class: 'dot' }),
    h('span', { class: 'name', text: S.account.connected ? modelName(S.settings.model) : 'Link Gemini' }),
  );
  chip.title = S.account.connected
    ? `Linked to your Google Gemini account (key ${S.account.masked}). Click to change the model.`
    : 'Link your Google Gemini account';
}

function setWatch(state, text) {
  const w = $('#connect-watch');
  w.className = `watch${state === 'found' ? ' found' : state === 'bad' ? ' bad' : ''}`;
  $('.spinner', w).hidden = state === 'bad' || state === 'idle';
  $('#connect-watch-text').textContent = text;
}

function startKeyWatch() {
  const ch = makeChannel((ev) => {
    if ($('#connect').hidden) return;
    if (ev.type === 'found') setWatch('found', 'Key found — checking it with Google…');
    else if (ev.type === 'invalid') setWatch('bad', ev.message);
    else if (ev.type === 'linked') onLinked(ev.masked, ev.models);
    else if (ev.type === 'stopped' && $('#connect-done').hidden) setWatch('idle', 'Stopped watching. Paste your key below instead.');
  });
  invoke('key_watch_start', { onEvent: ch }).catch((e) => setWatch('bad', normErr(e).message));
}

function openConnect(changing = false) {
  $('#connect').hidden = false;
  $('#connect-done').hidden = true;
  $('#connect-error').hidden = true;
  $('#connect-key').value = '';
  $('#connect-sub').textContent = changing
    ? 'Link a different API key. It replaces the one this app uses now.'
    : 'Super Prompt Creator runs on Gemini through your own Google account. It takes about a minute, once.';
  setWatch('wait', 'Waiting for you to copy your key…');
  startKeyWatch();
  requestAnimationFrame(() => $('#connect-open').focus());
}

function closeConnect() {
  $('#connect').hidden = true;
  invoke('key_watch_stop').catch(() => {});
}

function onLinked(masked, models) {
  S.account = { connected: true, masked };
  setModels(models);
  invoke('key_watch_stop').catch(() => {});
  $('#connect-done').hidden = false;
  $('#connect-done-text').textContent = `Using ${modelName(S.settings.model)} with your key ${masked}.`;
  renderSettings();
  setTimeout(() => {
    $('#connect').hidden = true;
    toast('Linked to your Google Gemini account');
    if (S.view === 'create') $('#idea').focus();
  }, 1600);
}

async function submitKey(e) {
  e.preventDefault();
  const input = $('#connect-key');
  const key = input.value.trim();
  if (!key) { input.focus(); return; }
  const btn = $('#connect-submit');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('#connect-error').hidden = true;
  try {
    const r = await invoke('gemini_connect', { key });
    onLinked(r.masked, r.models);
  } catch (err) {
    const x = normErr(err);
    $('#connect-error').textContent = x.message;
    $('#connect-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Link';
  }
}

async function disconnect() {
  const ok = await modal({
    title: 'Unlink your Gemini account?',
    body: 'The API key is removed from this PC. Your saved prompts stay, and you can link again any time.',
    actions: [{ label: 'Cancel', value: false }, { label: 'Unlink', value: true, class: 'danger' }],
  });
  if (!ok) return;
  await invoke('gemini_disconnect').catch(() => {});
  S.account = { connected: false, masked: '' };
  S.models = [];
  renderAccountChip();
  renderGoButton();
  renderSettings();
  toast('Unlinked from Gemini');
}

function handleAuthError(err) {
  if (/link your google gemini account first/i.test(err.message)) {
    S.account = { connected: false, masked: '' };
    renderAccountChip();
    renderGoButton();
    openConnect();
  }
}

// ------------------------------------------------------------------ composer
const TARGET_ICONS = { gemini: 'spark', chatgpt: 'bubble', claude: 'feather', any: 'globe', image: 'image', video: 'video' };

function fillSelect(sel, items, value) {
  sel.replaceChildren(...items.map(([k, label]) => h('option', { value: k }, label)));
  sel.value = value;
}

function renderComposer() {
  const d = S.draft;
  const valid = (list, v) => list.some(([k]) => k === v);
  if (!TARGETS[d.target]) d.target = 'gemini';
  if (!valid(TEXT_TYPES, d.kind)) d.kind = 'auto';
  if (!valid(IMAGE_MODELS, d.imageModel)) d.imageModel = 'gemini';
  if (!valid(VIDEO_MODELS, d.videoModel)) d.videoModel = 'veo';
  if (!valid(DETAILS, d.detail)) d.detail = 'balanced';
  const kind = TARGETS[d.target].kind;
  $$('.seg-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
  $('#target-chips').replaceChildren(...Object.entries(TARGETS).map(([key, t]) => h('button', {
    class: `chip${d.target === key ? ' active' : ''}`,
    onclick: () => { d.target = key; persistDraft(); renderComposer(); },
  }, ic(TARGET_ICONS[key]), t.label)));
  $('#field-kind').hidden = kind !== 'text';
  $('#field-media').hidden = kind === 'text';
  if (kind === 'text') fillSelect($('#kind-select'), TEXT_TYPES, d.kind);
  else if (kind === 'image') { $('#media-label').textContent = 'Image model'; fillSelect($('#media-select'), IMAGE_MODELS, d.imageModel); }
  else { $('#media-label').textContent = 'Video model'; fillSelect($('#media-select'), VIDEO_MODELS, d.videoModel); }
  $('#detail-seg').replaceChildren(...DETAILS.map(([k, label]) => h('button', {
    class: d.detail === k ? 'active' : '',
    onclick: () => { d.detail = k; persistDraft(); renderComposer(); },
  }, label)));
  $('#opt-ask').checked = d.askFirst;
  $('#opt-blanks').checked = d.blanks;
  $('#opt-examples').checked = d.examples;
  $('#opt-aiasks').checked = d.aiAsks;
  $('#opt-ask-wrap').hidden = S.mode === 'improve';
  $('#opt-examples-wrap').hidden = kind !== 'text';
  $('#opt-aiasks-wrap').hidden = kind !== 'text' || d.kind === 'assistant';
  $('#idea').placeholder = S.mode === 'improve' ? PLACEHOLDER_TEXT.improve : PLACEHOLDER_TEXT[kind];
  renderGoButton();
}

function renderGoButton() {
  const go = $('#go');
  const busy = !!(S.busy && (S.busy.type === 'interview' || S.busy.type === 'generate'));
  go.classList.toggle('stop', busy);
  go.replaceChildren(
    ic(busy ? 'stop' : S.mode === 'improve' ? 'wand' : 'spark'),
    h('span', { text: busy ? 'Stop' : S.mode === 'improve' ? 'Improve my prompt' : 'Create super prompt' }),
    busy ? h('kbd', { text: 'Esc' }) : h('kbd', { text: 'Ctrl ↵' }),
  );
  go.disabled = !!(S.busy && S.busy.type === 'test');
  $('#go-hint').textContent = S.account.connected
    ? `Runs on your Gemini account · ${modelName(S.settings.model)}`
    : 'Link your Google Gemini account to start.';
}

function updateIdeaCount() {
  const n = S.draft.idea.length;
  $('#idea-count').textContent = `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;
  $('#idea-clear').hidden = !n;
}
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.46)}px`;
}
function setIdea(text) {
  S.draft.idea = text;
  const ta = $('#idea');
  ta.value = text;
  autosize(ta);
  updateIdeaCount();
}

function useExample(e) {
  if (S.busy) return;
  S.mode = 'create';
  Object.assign(S.draft, { target: e.target, ...(e.kind ? { kind: e.kind } : {}), ...(e.imageModel ? { imageModel: e.imageModel } : {}), ...(e.videoModel ? { videoModel: e.videoModel } : {}) });
  setIdea(e.text);
  persistDraft();
  renderComposer();
  $('#idea').focus();
}

// ------------------------------------------------------------------ Gemini calls
function snapshotOpts() {
  const d = S.draft;
  return {
    mode: S.mode, idea: d.idea, target: d.target, kind: d.kind, imageModel: d.imageModel, videoModel: d.videoModel,
    detail: d.detail, blanks: d.blanks, examples: d.examples, aiAsks: d.aiAsks,
  };
}

function responseText(res) {
  const parts = (res && res.candidates && res.candidates[0] && res.candidates[0].content && res.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

/** Stream a request; resolves once with { ok, finishReason, … } or { ok:false, error }. */
function streamGemini({ model, body, onStart, onDelta, onImage }) {
  return new Promise((resolve) => {
    const requestId = reqSeq++;
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
    const ch = makeChannel((ev) => {
      if (finished) return;
      if (ev.type === 'delta') onDelta && onDelta(ev.text);
      else if (ev.type === 'image') onImage && onImage(ev);
      else if (ev.type === 'done') finish({ ok: true, finishReason: ev.finishReason, blockReason: ev.blockReason, usage: ev.usage, modelVersion: ev.modelVersion });
      else if (ev.type === 'error') finish({ ok: false, error: { kind: ev.kind, message: ev.message } });
    });
    onStart && onStart(requestId);
    invoke('gemini_stream', { requestId, model, body, onEvent: ch })
      .then(() => setTimeout(() => finish({ ok: true, finishReason: null }), 4000))
      .catch((e) => finish({ ok: false, error: normErr(e) }));
  });
}

function blockedOrEmpty(r) {
  const fr = r.finishReason || '';
  if (r.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(fr)) {
    return { kind: 'blocked', message: "Gemini's safety filters stopped this request. Try rephrasing your idea." };
  }
  if (fr === 'RECITATION') return { kind: 'blocked', message: 'Gemini stopped because the answer was too close to existing text. Try rephrasing.' };
  return { kind: 'other', message: 'Gemini sent back an empty answer. Please try again.' };
}

const ERROR_TITLES = {
  auth: 'Your Gemini key needs attention', quota: 'Gemini limit reached', network: 'Connection problem',
  server: 'Gemini is busy', region: 'Not available in your region', model: 'Model unavailable', blocked: 'Gemini declined this one',
};

function errorCard(err, retry) {
  const actions = h('div', { class: 'btn-row' });
  if (retry) actions.append(h('button', { class: 'primary', onclick: retry }, ic('refresh'), 'Try again'));
  if (err.kind === 'auth') actions.append(h('button', { class: 'soft', onclick: () => openConnect(true) }, ic('key'), 'Link a key'));
  if (err.kind === 'model' || err.kind === 'quota') actions.append(h('button', { class: 'soft', onclick: () => setView('settings') }, ic('settings'), 'Change model'));
  return h('div', { class: 'card error-card' }, ic('alert'), h('div', {},
    h('h3', { text: ERROR_TITLES[err.kind] || 'Something went wrong' }),
    h('p', { text: err.message }),
    actions));
}

function stopAll() {
  const b = S.busy;
  if (!b) return;
  if (b.requestId != null) invoke('gemini_cancel', { requestId: b.requestId }).catch(() => {});
  if (b.type === 'interview') {
    genToken++;
    S.busy = null;
    S.stage = S.session ? 'result' : 'empty';
    renderStage();
    renderGoButton();
  }
}

async function onGo() {
  if (S.busy) { stopAll(); return; }
  const idea = S.draft.idea.trim();
  if (!idea) {
    const card = $('#idea-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    $('#idea').focus();
    return;
  }
  if (!S.account.connected) { openConnect(); return; }
  if (!S.settings.model) {
    await loadModels();
    if (!S.settings.model) { toast('No Gemini text model is available for your key yet.', 'err', 5000); return; }
  }
  const iv = S.interview;
  if (S.stage === 'interview' && iv && iv.opts.idea === S.draft.idea && iv.opts.mode === S.mode) {
    runGenerate(collectAnswers(), iv.opts); // the questions are already on screen: use the answers
    return;
  }
  if (S.mode === 'create' && S.draft.askFirst) runInterview();
  else runGenerate(null, snapshotOpts());
}

async function runInterview() {
  const opts = snapshotOpts();
  const token = ++genToken;
  S.busy = { type: 'interview', token, requestId: null };
  S.stage = 'interview-loading';
  S.error = null;
  renderStage();
  renderGoButton();
  let res;
  try {
    res = await invoke('gemini_generate', { model: S.settings.model, body: interviewRequest(opts) });
  } catch (e) {
    if (token !== genToken) return;
    S.busy = null;
    const err = normErr(e);
    if (['auth', 'quota', 'network', 'region', 'model'].includes(err.kind)) {
      handleAuthError(err);
      S.stage = 'error';
      S.error = { ...err, retry: () => runInterview() };
      renderStage();
      renderGoButton();
      return;
    }
    runGenerate(null, opts); // the questions are optional
    return;
  }
  if (token !== genToken) return;
  S.busy = null;
  let qs = [];
  try {
    qs = (JSON.parse(responseText(res)).questions || [])
      .filter((q) => q && q.question)
      .slice(0, 4)
      .map((q) => ({ question: String(q.question), options: (q.options || []).map(String).filter(Boolean).slice(0, 5), answer: '', custom: '' }));
  } catch { qs = []; }
  if (!qs.length) { runGenerate(null, opts); return; }
  S.interview = { opts, questions: qs };
  S.stage = 'interview';
  renderStage();
  renderGoButton();
}

function collectAnswers() {
  return S.interview.questions.map((q) => ({ question: q.question, answer: (q.custom || q.answer || '').trim() }));
}

function newSession(opts, userText, answers) {
  const now = Date.now();
  return {
    id: uid(), title: '', titleEdited: false, mode: opts.mode, opts, userText, answers: answers || [],
    versions: [], current: 0, fills: {}, starred: false, createdAt: now, updatedAt: now, test: null,
  };
}

async function runGenerate(answers, opts) {
  const improving = opts.mode === 'improve';
  const req = improving ? improveRequest(opts) : createRequest(opts, answers);
  const s = newSession(opts, req.userText, answers);
  S.session = s;
  S.interview = null;
  S.stage = 'result';
  S.tab = 'prompt';
  S.editing = false;
  renderStage();
  const retry = () => runGenerate(answers, opts);
  await streamVersion(s, { kind: improving ? 'improve' : 'create', body: req.body, retry });
}

async function streamVersion(s, { kind, body, feedback, retry }) {
  const token = ++genToken;
  const model = S.settings.model;
  const v = { raw: '', prompt: '', notes: [], title: '', kind, feedback: feedback || '', model, at: Date.now(), ms: 0, streaming: true, error: null };
  const prevCurrent = s.current;
  s.versions.push(v);
  s.current = s.versions.length - 1;
  S.busy = { type: 'generate', token, requestId: null };
  S.editing = false;
  S.tab = 'prompt';
  renderGoButton();
  if (S.session === s && S.stage === 'result') updateResult();
  const t0 = performance.now();
  const timer = setInterval(() => { if (S.session === s) paintThinkingTime(t0); }, 500);
  const r = await streamGemini({
    model,
    body,
    onStart: (id) => { if (S.busy && S.busy.token === token) S.busy.requestId = id; },
    onDelta: (txt) => {
      v.raw += txt;
      Object.assign(v, splitOutput(v.raw, true));
      schedulePaint();
    },
  });
  clearInterval(timer);
  v.ms = performance.now() - t0;
  v.streaming = false;
  if (S.busy && S.busy.token === token) S.busy = null;
  Object.assign(v, splitOutput(v.raw, false));
  let failure = null;
  if (!r.ok) failure = r.error;
  else if (!v.prompt.trim() && r.finishReason !== 'CANCELLED') failure = blockedOrEmpty(r);

  if (!v.prompt.trim()) {
    // Nothing usable: drop the empty version.
    s.versions.pop();
    s.current = Math.min(prevCurrent, Math.max(0, s.versions.length - 1));
    if (failure) {
      handleAuthError(failure);
      if (!s.versions.length) {
        if (S.session === s) { S.stage = 'error'; S.error = { ...failure, retry }; }
      } else {
        toast(failure.message, 'err', 6500);
      }
    } else if (!s.versions.length && S.session === s) {
      S.stage = 'empty'; // stopped before anything arrived
      S.session = null;
    }
  } else {
    if (failure) { v.error = { ...failure }; v.retry = retry; }
    if (r.ok && r.finishReason === 'CANCELLED') v.stopped = true;
    if (r.ok && r.finishReason === 'MAX_TOKENS') toast('Gemini hit its length limit, so the end may be cut off.', 'info', 5000);
    if (!s.titleEdited && v.title) s.title = v.title;
    if (!s.title) s.title = fallbackTitle(s.opts.idea);
    saveToLibrary(s);
  }
  renderGoButton();
  if (S.session === s || S.stage === 'error' || S.stage === 'empty') {
    if (S.stage === 'result') {
      updateResult();
      // Streaming followed the end of the text; start reading from the top.
      if (R && v.prompt.trim()) R.scroll.scrollTo({ top: 0, behavior: 'smooth' });
    } else renderStage();
  }
  return !!v.prompt.trim();
}

async function doRefine(feedback, label) {
  const text = (feedback || '').trim();
  const s = S.session;
  const v = curV();
  if (!text) { R && R.refineInput.focus(); return; }
  if (!s || !v || !v.prompt || S.busy) return;
  if (!S.account.connected) { openConnect(); return; }
  const typed = !label;
  if (typed) R.refineInput.value = '';
  const body = refineRequest(s.opts, s.mode === 'improve', s.userText, v.raw, text);
  const ok = await streamVersion(s, { kind: 'refine', body, feedback: label || text, retry: () => doRefine(text, label) });
  if (!ok && typed && R && !R.refineInput.value) R.refineInput.value = text;
}

async function confirmBlanks(prompt, fills, goLabel) {
  const missing = placeholders(prompt).filter((n) => !(fills[n] && fills[n].trim()));
  if (!missing.length) return true;
  const body = h('div', {},
    h('p', { text: missing.length === 1 ? 'This blank is still empty:' : 'These blanks are still empty:' }),
    h('ul', {}, missing.map((n) => h('li', {}, h('code', { text: `{{${n}}}` })))),
    h('p', { class: 'muted small', text: 'Fill them in under the prompt for a better result.' }));
  const r = await modal({ title: 'Some blanks are empty', body, actions: [{ label: 'Fill them in', value: 'fill' }, { label: goLabel, value: 'go', class: 'primary' }] });
  if (r === 'fill') {
    S.tab = 'prompt';
    S.editing = false;
    updateResult();
    const input = $(`[data-blank="${CSS.escape(missing[0])}"]`);
    if (input) { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); input.focus(); }
  }
  return r === 'go';
}

async function runTest() {
  const s = S.session;
  const v = curV();
  if (!s || !v || !v.prompt || S.busy) return;
  if (!S.account.connected) { openConnect(); return; }
  const kind = TARGETS[s.opts.target].kind;
  if (kind === 'video') return;
  if (!(await confirmBlanks(v.prompt, s.fills, 'Test anyway'))) return;
  const text = fillPlaceholders(v.prompt, s.fills);
  let model = S.settings.model;
  let body = { contents: [{ role: 'user', parts: [{ text }] }] };
  if (kind === 'image') {
    model = S.settings.imageModel;
    if (!model || model === 'none') {
      toast('Your key has no Gemini image model, so image prompts can\'t be test-run here. Use "Send to Gemini" instead.', 'err', 7000);
      return;
    }
    body = { ...body, generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
  }
  const token = ++genToken;
  const t = { text: '', images: [], model, at: Date.now(), ms: 0, running: true, error: null, forVersion: s.current };
  s.test = t;
  S.tab = 'test';
  S.editing = false;
  S.busy = { type: 'test', token, requestId: null };
  renderGoButton();
  updateResult();
  const t0 = performance.now();
  const r = await streamGemini({
    model,
    body,
    onStart: (id) => { if (S.busy && S.busy.token === token) S.busy.requestId = id; },
    onDelta: (txt) => { t.text += txt; schedulePaint(); },
    onImage: (im) => { t.images.push({ mimeType: im.mimeType, data: im.data }); schedulePaint(); },
  });
  t.ms = performance.now() - t0;
  t.running = false;
  if (S.busy && S.busy.token === token) S.busy = null;
  if (!r.ok) { t.error = r.error; handleAuthError(r.error); }
  else if (!t.text && !t.images.length && r.finishReason !== 'CANCELLED') t.error = blockedOrEmpty(r);
  renderGoButton();
  if (S.session === s && S.stage === 'result') updateResult();
}

// ------------------------------------------------------------------ actions
const curV = () => (S.session ? S.session.versions[S.session.current] : null);

async function copyText(text, msg = 'Copied to clipboard') {
  try {
    await invoke('clipboard_write', { text });
    toast(msg);
    return true;
  } catch (e) {
    try { await navigator.clipboard.writeText(text); toast(msg); return true; } catch { /* fall through */ }
    toast(`Couldn't copy: ${normErr(e).message}`, 'err');
    return false;
  }
}

function copyPrompt() {
  const v = curV();
  if (!v || !v.prompt || v.streaming) return;
  copyText(fillPlaceholders(v.prompt, S.session.fills), 'Super prompt copied');
}

// ------------------------------------------------------------------ chat sites (Gemini, ChatGPT, Claude)
const SITES = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude' };
const SITE_URLS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new' };
const SITE_ICONS = { gemini: 'chat', chatgpt: 'bubble', claude: 'feather' };
const sendSiteFor = (target) => (SITES[target] ? target : 'gemini');

async function refreshSites() {
  try {
    const st = await invoke('sites_status');
    if (st && typeof st === 'object') S.sites = { ...S.sites, ...st };
  } catch { /* keep the last known state */ }
  return S.sites;
}

function openSite(site) {
  S.settings.sitesOpened[site] = true;
  saveSettings();
  invoke('site_open', { target: site }).catch((e) => toast(normErr(e).message, 'err'));
}

async function sendTo(site) {
  const s = S.session;
  const v = curV();
  if (!v || !v.prompt) return;
  if (!(await confirmBlanks(v.prompt, s.fills, 'Send anyway'))) return;
  const name = SITES[site];
  const status = await refreshSites();
  if (!status[site] && !S.settings.sitesOpened[site]) {
    // First time: sign in before anything is typed into a signed-out chat.
    openSite(site);
    await modal({
      title: `Sign in to ${name} first`,
      body: `A ${name} window just opened inside this app. Sign in there once (the app remembers it), then click “Send to ${name}” again.`,
      actions: [{ label: 'OK', value: true, class: 'primary' }],
    });
    return;
  }
  const text = fillPlaceholders(v.prompt, s.fills);
  const autoSend = S.settings.sendMode === 'send';
  try {
    await invoke('chat_send', { site, text, autoSend });
    S.settings.sitesOpened[site] = true;
    saveSettings();
    toast(autoSend ? `Opening ${name} and sending your prompt…` : `Opening ${name} with your prompt typed in…`, 'info', 4000);
  } catch (e) {
    toast(normErr(e).message, 'err', 5000);
  }
}

async function openInBrowser(site) {
  const s = S.session;
  const v = curV();
  if (!v || !v.prompt) return;
  if (!(await confirmBlanks(v.prompt, s.fills, 'Copy anyway'))) return;
  if (await copyText(fillPlaceholders(v.prompt, s.fills), `Copied — paste it into ${SITES[site]} with Ctrl+V`)) {
    invoke('open_url', { url: SITE_URLS[site] }).catch((e) => toast(normErr(e).message, 'err'));
  }
}

function sendMenu(anchor) {
  const cur = sendSiteFor(S.session.opts.target);
  const items = Object.keys(SITES).map((site) => ({
    icon: SITE_ICONS[site], label: `Send to ${SITES[site]}`, hint: S.sites[site] ? 'signed in' : '', onclick: () => sendTo(site),
  }));
  items.push('-', { icon: 'external', label: `Copy & open ${SITES[cur]} in my browser`, onclick: () => openInBrowser(cur) });
  popMenu(anchor, items);
}

async function signOutSite(site) {
  const name = SITES[site];
  const ok = await modal({
    title: `Sign out of ${name} in this app?`,
    body: site === 'gemini'
      ? 'Closes the Gemini window and removes your Google sign-in from this app (AI Studio too). Your API key link and saved prompts are not affected.'
      : `Closes the ${name} window and removes your ${name} sign-in from this app. Your saved prompts are not affected.`,
    actions: [{ label: 'Cancel', value: false }, { label: 'Sign out', value: true, class: 'danger' }],
  });
  if (!ok) return;
  try {
    await invoke('site_signout', { site });
    S.settings.sitesOpened[site] = false;
    saveSettings();
    await refreshSites();
    renderSettings();
    toast(`Signed out of ${name} in this app`);
  } catch (e) {
    toast(normErr(e).message, 'err');
  }
}

let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('mousedown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }
function popMenu(anchor, items) {
  closeMenu();
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.map((it) => (it === '-'
    ? h('div', { class: 'menu-sep' })
    : h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { closeMenu(); it.onclick(); } },
      ic(it.icon), h('span', { class: 'menu-label', text: it.label }), it.hint ? h('span', { class: 'menu-hint', text: it.hint }) : null))));
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const w = menuEl.offsetWidth;
  menuEl.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menuEl.style.top = `${r.bottom + 6}px`;
  document.addEventListener('mousedown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  const firstItem = menuEl.querySelector('.menu-item');
  if (firstItem) firstItem.focus();
}

async function openGemCreator() {
  const v = curV();
  if (!v || !v.prompt) return;
  if (await copyText(fillPlaceholders(v.prompt, S.session.fills), "Copied — paste it into the Gem's Instructions box")) {
    invoke('site_open', { target: 'gems' }).catch((e) => toast(normErr(e).message, 'err'));
  }
}

async function exportPrompt() {
  const s = S.session;
  const v = curV();
  if (!v || !v.prompt) return;
  try {
    const path = await invoke('export_text', { suggestedName: s.title || 'super-prompt', content: `${fillPlaceholders(v.prompt, s.fills)}\n`, ext: 'md' });
    if (path) toast(`Saved to ${path}`, 'ok', 4500);
  } catch (e) {
    toast(normErr(e).message, 'err');
  }
}

function composeRaw(v) {
  const notes = [v.title ? `Title: ${v.title}` : '', ...v.notes.map((n) => `- ${n}`)].filter(Boolean).join('\n');
  return notes ? `${v.prompt}\n\n---NOTES---\n${notes}` : v.prompt;
}

function toggleEdit() {
  const s = S.session;
  const v = curV();
  if (!v) return;
  if (!S.editing) {
    S.editing = true;
    updateResult();
    requestAnimationFrame(() => { if (R && R.editor) { R.editor.focus(); autosize(R.editor); } });
    return;
  }
  const txt = R.editor.value.trim();
  if (txt && txt !== v.prompt) {
    v.prompt = txt;
    v.raw = composeRaw(v);
    v.edited = true;
    saveToLibrary(s);
    toast('Changes saved');
  }
  S.editing = false;
  updateResult();
}

function setTab(tab) {
  if (S.tab === tab) return;
  if (S.editing) toggleEdit();
  S.tab = tab;
  updateResult();
}

// ------------------------------------------------------------------ library
function serialize(s) {
  const versions = s.versions.filter((v) => !v.streaming && v.prompt).map((v) => ({
    raw: v.raw, prompt: v.prompt, notes: v.notes, title: v.title, kind: v.kind, feedback: v.feedback,
    model: v.model, at: v.at, ms: Math.round(v.ms || 0), edited: !!v.edited, stopped: !!v.stopped,
  }));
  return {
    id: s.id, title: s.title, titleEdited: !!s.titleEdited, mode: s.mode, opts: s.opts, userText: s.userText,
    answers: s.answers, fills: s.fills, starred: !!s.starred, createdAt: s.createdAt, updatedAt: s.updatedAt,
    current: Math.min(s.current, Math.max(0, versions.length - 1)), versions,
  };
}

function saveToLibrary(s) {
  if (!s.versions.some((v) => v.prompt && !v.streaming)) return;
  s.updatedAt = Date.now();
  const entry = serialize(s);
  const i = S.library.findIndex((e) => e.id === s.id);
  if (i >= 0) S.library[i] = entry; else S.library.unshift(entry);
  S.library.sort((a, b) => b.updatedAt - a.updatedAt);
  if (S.library.length > 500) S.library = S.library.filter((e, idx) => e.starred || idx < 500);
  saveLibrary();
  if (S.view === 'library') renderLibrary();
}
const saveSessionSoon = debounce((s) => saveToLibrary(s), 600);

function openEntry(e) {
  if (S.busy) { toast('Wait for Gemini to finish (or press Esc to stop).', 'info'); return; }
  const s = structuredClone(e);
  if (!s.versions.length) return;
  s.versions.forEach((v) => { v.streaming = false; v.error = null; v.notes = v.notes || []; });
  s.fills = s.fills || {};
  s.test = null;
  s.current = Math.min(Number.isInteger(s.current) ? s.current : s.versions.length - 1, s.versions.length - 1);
  S.session = s;
  S.stage = 'result';
  S.tab = 'prompt';
  S.editing = false;
  S.mode = s.mode === 'improve' ? 'improve' : 'create';
  Object.assign(S.draft, { ...DEFAULT_DRAFT, ...s.opts });
  delete S.draft.mode;
  setIdea(S.draft.idea || '');
  setView('create');
  renderComposer();
  renderStage();
}

function libKind(e) { return (TARGETS[e.opts && e.opts.target] || TARGETS.gemini).kind; }

function renderLibrary() {
  const q = S.libQuery.trim().toLowerCase();
  const F = S.libFilter;
  const match = (e, f) => (f === 'all') || (f === 'starred' ? e.starred : libKind(e) === f);
  const filters = [['all', 'All'], ['starred', 'Starred'], ['text', 'Text'], ['image', 'Image'], ['video', 'Video']];
  $('#lib-filters').replaceChildren(...filters.map(([k, label]) => h('button', {
    class: `chip small${F === k ? ' active' : ''}`,
    onclick: () => { S.libFilter = k; renderLibrary(); },
  }, k === 'starred' ? ic('star') : null, label, h('span', { class: 'muted', text: ` ${S.library.filter((e) => match(e, k)).length}` }))));
  const items = S.library.filter((e) => {
    if (!match(e, F)) return false;
    if (!q) return true;
    const v = e.versions[e.current] || e.versions[e.versions.length - 1] || {};
    return `${e.title} ${(e.opts && e.opts.idea) || ''} ${v.prompt || ''}`.toLowerCase().includes(q);
  });
  const grid = $('#lib-grid');
  if (!items.length) {
    grid.replaceChildren(h('div', { class: 'lib-empty', style: 'grid-column:1/-1' },
      h('h3', { text: S.library.length ? 'Nothing matches' : 'No prompts yet' }),
      h('p', { text: S.library.length ? 'Try a different search or filter.' : 'Every super prompt you create is saved here automatically.' })));
    return;
  }
  grid.replaceChildren(...items.map(libCard));
}

function libCard(e) {
  const v = e.versions[e.current] || e.versions[e.versions.length - 1] || { prompt: '' };
  const t = TARGETS[e.opts && e.opts.target] || TARGETS.gemini;
  const del = async (ev) => {
    ev.stopPropagation();
    const ok = await modal({
      title: 'Delete this prompt?',
      body: `“${e.title || 'Untitled prompt'}” will be removed from your library. This can't be undone.`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, class: 'danger' }],
    });
    if (!ok) return;
    S.library = S.library.filter((x) => x.id !== e.id);
    if (S.session && S.session.id === e.id) S.session.id = uid(); // keep it open, but as a new entry if changed again
    saveLibrary();
    renderLibrary();
    toast('Prompt deleted');
  };
  return h('div', {
    class: 'lib-card', tabindex: '0', title: 'Open',
    onclick: () => openEntry(e),
    onkeydown: (ev) => { if (ev.key === 'Enter') openEntry(e); },
  },
  h('button', {
    class: `star-corner${e.starred ? ' on' : ''}`, title: e.starred ? 'Unstar' : 'Star',
    onclick: (ev) => {
      ev.stopPropagation();
      e.starred = !e.starred;
      if (S.session && S.session.id === e.id) S.session.starred = e.starred;
      saveLibrary();
      renderLibrary();
    },
  }, ic('star')),
  h('h3', { text: e.title || 'Untitled prompt' }),
  h('div', { class: 'meta' },
    h('span', { class: 'badge accent', text: t.label }),
    e.mode === 'improve' ? h('span', { class: 'badge', text: 'Improved' }) : null,
    e.versions.length > 1 ? h('span', { class: 'badge', text: `${e.versions.length} versions` }) : null),
  h('div', { class: 'preview', text: (v.prompt || '').slice(0, 420) }),
  h('div', { class: 'foot' },
    h('span', { class: 'date', text: fmtDate(e.updatedAt || e.createdAt) }),
    h('button', { title: 'Copy prompt', onclick: (ev) => { ev.stopPropagation(); copyText(fillPlaceholders(v.prompt, e.fills || {}), 'Prompt copied'); } }, ic('copy')),
    h('button', { class: 'del', title: 'Delete', onclick: del }, ic('trash'))));
}

// ------------------------------------------------------------------ stage
function renderStage() {
  const st = $('#stage');
  R = null;
  if (S.stage === 'interview-loading') {
    st.replaceChildren(h('div', { class: 'loading-card' }, h('div', { class: 'orb' }), h('div', { text: 'Thinking of a few quick questions…' }),
      h('button', { class: 'ghost', onclick: () => { stopAll(); runGenerate(null, snapshotOpts()); } }, 'Skip questions')));
    return;
  }
  if (S.stage === 'interview' && S.interview) { st.replaceChildren(renderInterview()); return; }
  if (S.stage === 'error' && S.error) {
    const err = S.error;
    st.replaceChildren(h('div', { class: 'empty' }, h('div', { style: 'width:min(560px,100%)' }, errorCard(err, err.retry ? () => { S.stage = 'empty'; err.retry(); } : null))));
    return;
  }
  if (S.stage === 'result' && S.session) { renderResult(); return; }
  st.replaceChildren(renderEmpty());
}

function exampleTag(e) {
  const t = TARGETS[e.target];
  if (t.kind === 'image') return 'Image prompt';
  if (t.kind === 'video') return 'Video prompt';
  const k = TEXT_TYPES.find(([key]) => key === e.kind);
  return `${t.label} · ${k ? k[1] : 'Prompt'}`;
}

function renderEmpty() {
  return h('div', { class: 'empty' },
    h('div', { class: 'hero-logo', html: logo() }),
    h('h2', { text: 'Your super prompt appears here' }),
    h('p', { text: 'Describe what you want on the left, or start from an example. Gemini turns it into a detailed, ready-to-use prompt.' }),
    h('div', { class: 'examples' }, EXAMPLES.map((e) => h('button', { class: 'example', onclick: () => useExample(e) },
      h('span', { class: 'ex-ic', html: icon(e.icon) }),
      h('span', {}, e.text, h('span', { class: 'ex-tag', text: exampleTag(e) }))))));
}

function renderInterview() {
  const iv = S.interview;
  const cards = iv.questions.map((q, qi) => {
    const custom = h('input', {
      placeholder: 'Or type your own answer…', value: q.custom || '',
      oninput: (e) => {
        q.custom = e.target.value;
        if (q.custom) { q.answer = ''; $$('.chip', chips).forEach((c) => c.classList.remove('active')); }
      },
    });
    const chips = h('div', { class: 'chips' }, q.options.map((opt) => h('button', {
      class: `chip${q.answer === opt ? ' active' : ''}`,
      onclick: (e) => {
        q.answer = q.answer === opt ? '' : opt;
        q.custom = '';
        custom.value = '';
        $$('.chip', chips).forEach((c) => c.classList.toggle('active', c === e.currentTarget && !!q.answer));
      },
    }, opt)));
    return h('div', { class: 'card q-card', style: `animation-delay:${qi * 70}ms` }, h('div', { class: 'q', text: q.question }), chips, custom);
  });
  return h('div', { class: 'questions' },
    h('div', { class: 'q-head' }, h('div', { class: 'badge-ic', html: icon('help') }), h('div', {},
      h('h2', { text: 'A few quick questions' }),
      h('p', { class: 'sub', text: 'Answer what you like. Anything you skip, Gemini decides for you.' }))),
    cards,
    h('div', { class: 'q-actions' },
      h('button', { class: 'ghost', onclick: () => runGenerate(null, iv.opts) }, 'Skip questions'),
      h('button', { class: 'primary', id: 'iv-go', onclick: () => runGenerate(collectAnswers(), iv.opts) }, ic('spark'), 'Create super prompt', h('kbd', { text: 'Ctrl ↵' }))));
}

function thinkingBlock(label) {
  return h('div', { class: 'skeleton' },
    h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), h('span', { class: 'think-label', text: label })),
    [94, 82, 88, 64].map((w) => h('div', { class: 'thinking' }, h('div', { class: 'bar', style: `width:${w}%` }))));
}

function paintThinkingTime(t0) {
  const el = R && R.promptView && $('.think-label', R.promptView);
  if (el) el.textContent = `Gemini is writing your super prompt… ${Math.floor((performance.now() - t0) / 1000)}s`;
}

function renderResult() {
  const s = S.session;
  R = {};
  R.title = h('input', {
    class: 'title-input', value: s.title || '', placeholder: 'Untitled prompt', title: 'Click to rename', spellcheck: 'false',
    onchange: (e) => { s.title = e.target.value.trim() || fallbackTitle(s.opts.idea); s.titleEdited = true; saveToLibrary(s); },
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
  });
  R.versions = h('div', { class: 'versions' });
  R.star = h('button', {
    class: 'star-btn',
    onclick: () => { s.starred = !s.starred; saveToLibrary(s); updateHeader(); toast(s.starred ? 'Starred' : 'Unstarred', 'info', 1400); },
  }, ic('star'));
  R.tabPrompt = h('button', { class: 'tab', onclick: () => setTab('prompt') }, ic('doc'), 'Super prompt');
  R.tabTest = h('button', { class: 'tab', onclick: () => setTab('test') }, ic('play'), 'Test run');
  R.toolbar = h('div', { class: 'toolbar' });
  R.scroll = h('div', { class: 'scroll' });
  R.scroll.addEventListener('click', onScrollClick);
  R.refine = buildRefine();
  R.stats = h('div', { class: 'stats' });
  $('#stage').replaceChildren(h('div', { class: 'result' },
    h('div', { class: 'result-head' }, R.title, R.versions, R.star),
    h('div', { class: 'tabs-bar' }, R.tabPrompt, R.tabTest),
    R.toolbar, R.scroll, R.refine, R.stats));
  updateResult();
}

function onScrollClick(e) {
  const a = e.target.closest('a.ext');
  if (a) { e.preventDefault(); invoke('open_url', { url: a.dataset.href }).catch((err) => toast(normErr(err).message, 'err')); return; }
  const cc = e.target.closest('.code-copy');
  if (cc) {
    const code = cc.closest('.codeblock');
    if (code) copyText($('code', code).textContent, 'Code copied');
  }
}

function updateResult() {
  if (!R || S.stage !== 'result' || !S.session) return;
  updateHeader();
  updateTabs();
  updateToolbar();
  updateBody();
  updateRefine();
  updateStats();
}

function updateHeader() {
  const s = S.session;
  if (document.activeElement !== R.title) R.title.value = s.title || '';
  R.versions.replaceChildren(...s.versions.map((v, i) => h('button', {
    class: `ver${i === s.current ? ' active' : ''}`,
    title: v.kind === 'refine' ? `Refined: ${v.feedback}` : v.kind === 'improve' ? 'Improved version' : 'First version',
    onclick: () => {
      if (S.busy || i === s.current) return;
      if (S.editing) toggleEdit();
      s.current = i;
      saveSessionSoon(s);
      updateResult();
    },
  }, `v${i + 1}`)));
  R.versions.hidden = s.versions.length < 2;
  R.star.classList.toggle('on', !!s.starred);
  R.star.title = s.starred ? 'Starred — click to unstar' : 'Star this prompt';
}

function updateTabs() {
  const kind = TARGETS[S.session.opts.target].kind;
  R.tabPrompt.classList.toggle('active', S.tab === 'prompt');
  R.tabTest.classList.toggle('active', S.tab === 'test');
  R.tabTest.hidden = kind === 'video';
  const running = S.session.test && S.session.test.running;
  const dot = $('.dot', R.tabTest);
  if (running && !dot) R.tabTest.append(h('span', { class: 'dot' }));
  if (!running && dot) dot.remove();
}

function tb(iconName, label, onclick, o = {}) {
  return h('button', { class: `tb${o.hot ? ' hot' : ''}`, disabled: !!o.disabled, title: o.title || label, onclick }, ic(iconName), label);
}

function updateToolbar() {
  const s = S.session;
  const v = curV();
  const kind = TARGETS[s.opts.target].kind;
  const streaming = !!(v && v.streaming);
  const ready = !!(v && v.prompt) && !streaming;
  if (S.tab === 'test') {
    const t = s.test;
    const running = !!(t && t.running);
    R.toolbar.replaceChildren(
      running
        ? tb('stop', 'Stop', () => stopAll(), { hot: true })
        : tb(t ? 'refresh' : 'play', t ? 'Run again' : 'Run test', () => runTest(), { hot: true, disabled: !ready || !!S.busy }),
      tb('copy', 'Copy answer', () => copyText(t.text, 'Answer copied'), { disabled: !t || !t.text || running }),
      tb('doc', 'Back to prompt', () => setTab('prompt')),
    );
    return;
  }
  const site = sendSiteFor(s.opts.target);
  const send = h('div', { class: 'split' },
    tb('send', `Send to ${SITES[site]}`, () => sendTo(site), { disabled: !ready, title: `Type it into a new ${SITES[site]} chat, signed in with your account` }),
    h('button', {
      class: 'tb split-more', disabled: !ready, title: 'Send it to Gemini, ChatGPT or Claude', 'aria-label': 'More send options',
      onclick: (e) => sendMenu(e.currentTarget),
    }, ic('chevron')));
  R.toolbar.replaceChildren(...[
    tb('copy', 'Copy', copyPrompt, { hot: true, disabled: !ready, title: 'Copy the prompt (Ctrl+Shift+C)' }),
    send,
    kind !== 'video' ? tb('play', 'Test run', runTest, { disabled: !ready || !!S.busy, title: kind === 'image' ? 'Generate a test image with your Gemini key' : 'Run the prompt with your Gemini key and read the answer here' }) : null,
    tb('edit', S.editing ? 'Done editing' : 'Edit', toggleEdit, { disabled: !ready, hot: S.editing }),
    tb('download', 'Export', exportPrompt, { disabled: !ready, title: 'Save as a Markdown file' }),
    kind === 'text' ? tb('bot', 'Make a Gem', openGemCreator, { disabled: !ready, title: 'Copy it and open the Gem creator in Gemini' }) : null,
  ].filter(Boolean));
}

function updateBody() {
  const v = curV();
  if (S.tab === 'test') {
    R.promptCard = null;
    paintTest();
    return;
  }
  if (S.editing) {
    R.promptCard = null;
    R.editor = h('textarea', { class: 'prompt-edit', spellcheck: 'true', oninput: (e) => autosize(e.target) });
    R.editor.value = v.prompt;
    R.scroll.replaceChildren(h('div', { class: 'card prompt-box' }, R.editor),
      h('p', { class: 'muted small', text: 'Edit anything you like, then click “Done editing”. Refine and Test run use your edited version.' }));
    return;
  }
  R.editor = null;
  if (!R.promptCard || !R.scroll.contains(R.promptCard)) {
    R.errBox = h('div');
    R.promptView = h('div', { class: 'prompt-view' });
    R.promptCard = h('div', { class: 'card prompt-box' }, R.promptView);
    R.side = h('div', { class: 'side-cards' });
    R.sideKey = null;
    R.scroll.replaceChildren(R.errBox, R.promptCard, R.side);
  }
  R.errBox.replaceChildren(...(v && v.error ? [errorCard({ ...v.error, message: `Stopped early: ${v.error.message}` }, v.retry)] : []));
  paintPrompt();
  paintSide();
}

function paintPrompt() {
  const v = curV();
  if (!v || !R || !R.promptView) return;
  if (v.streaming && !v.prompt) {
    if (!$('.skeleton', R.promptView)) R.promptView.replaceChildren(thinkingBlock('Gemini is writing your super prompt…'));
    return;
  }
  R.promptView.innerHTML = highlightPrompt(v.prompt, S.session.fills) + (v.streaming ? '<span class="caret"></span>' : '');
}

function paintSide() {
  const v = curV();
  if (!v || !R || !R.side) return;
  const names = v.streaming ? [] : placeholders(v.prompt);
  const key = `${S.session.current}|${names.join(',')}|${v.notes.join('\n')}`;
  if (key === R.sideKey) return;
  R.sideKey = key;
  const cards = [];
  if (names.length) cards.push(blanksCard(names));
  if (v.notes.length) {
    const changes = v.kind === 'improve';
    cards.push(h('div', { class: 'card mini-card' },
      h('h4', {}, ic(changes ? 'wand' : 'spark'), changes ? 'What changed' : 'Tips from Gemini'),
      h('ul', { class: 'note-list' }, v.notes.map((n) => h('li', { text: n.replace(/\*\*/g, '') })))));
  }
  R.side.replaceChildren(...cards);
}

function blanksCard(names) {
  const s = S.session;
  const count = h('span', { class: 'muted', style: 'margin-left:auto;text-transform:none;letter-spacing:0;font-weight:600' });
  const updateCount = () => { count.textContent = `${names.filter((n) => s.fills[n] && s.fills[n].trim()).length}/${names.length} filled`; };
  updateCount();
  const rows = names.map((n) => h('div', { class: 'blank-row' },
    h('label', { text: prettyPlaceholder(n) }),
    h('input', {
      value: s.fills[n] || '', placeholder: `{{${n}}}`, 'data-blank': n, spellcheck: 'true',
      oninput: (e) => { s.fills[n] = e.target.value; paintPrompt(); updateCount(); saveSessionSoon(s); },
    })));
  return h('div', { class: 'card mini-card' },
    h('h4', {}, ic('edit'), 'Fill in the blanks', count),
    rows,
    h('p', { class: 'muted small', style: 'margin:0', text: 'Copy, Test run and Send use your answers. Empty blanks stay as {{…}}.' }));
}

function paintTest() {
  const s = S.session;
  const t = s.test;
  const kind = TARGETS[s.opts.target].kind;
  const follow = nearBottom(R.scroll);
  if (!t) {
    R.scroll.replaceChildren(h('div', { class: 'card prompt-box' }, h('div', { class: 'empty', style: 'padding:36px 0' },
      h('h2', { text: kind === 'image' ? 'Try it as a real image' : 'See what your prompt produces' }),
      h('p', { text: kind === 'image'
        ? 'Generates a test image with a Gemini image model on your key (some keys need billing turned on for images).'
        : 'Runs the super prompt on your Gemini account and shows the answer here, so you can refine before you use it.' }),
      h('button', { class: 'primary', style: 'margin-top:16px', disabled: !!S.busy, onclick: () => runTest() }, ic('play'), 'Run test'))));
    return;
  }
  const box = h('div', { class: 'card prompt-box' });
  box.append(h('div', { class: 'stats', style: 'margin-bottom:12px' },
    h('span', {}, 'Test of ', h('b', { text: `v${t.forVersion + 1}` })),
    h('span', { text: modelName(t.model) }),
    t.ms && !t.running ? h('span', { text: `${(t.ms / 1000).toFixed(1)} s` }) : null));
  if (t.images.length) {
    box.append(h('div', { class: 'test-images' }, t.images.map((im) => h('figure', {}, h('img', { src: `data:${im.mimeType};base64,${im.data}`, alt: 'Test image from Gemini' })))));
    box.append(h('p', { class: 'muted small', text: 'Right-click an image to copy or save it.' }));
  }
  if (t.text) {
    const md = h('div', { class: 'md' });
    md.innerHTML = renderMarkdown(t.text) + (t.running ? '<span class="caret"></span>' : '');
    box.append(md);
  } else if (t.running && !t.images.length) {
    box.append(thinkingBlock(kind === 'image' ? 'Gemini is painting…' : 'Gemini is answering…'));
  }
  if (t.error) box.append(errorCard(t.error, () => runTest()));
  R.scroll.replaceChildren(box);
  if (follow && t.running) R.scroll.scrollTop = R.scroll.scrollHeight;
}

function buildRefine() {
  R.refineInput = h('input', {
    placeholder: 'Tell it what to change… e.g. “aimed at complete beginners”',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doRefine(R.refineInput.value); } },
  });
  R.refineChips = h('div', { class: 'chips' });
  R.refineBtn = h('button', { class: 'primary', onclick: () => doRefine(R.refineInput.value) }, ic('wand'), 'Refine');
  return h('div', { class: 'refine' }, R.refineChips,
    h('div', { class: 'refine-row' }, h('div', { class: 'refine-input' }, ic('spark'), R.refineInput), R.refineBtn));
}

function updateRefine() {
  const s = S.session;
  const kind = TARGETS[s.opts.target].kind;
  const v = curV();
  const disabled = !!S.busy || !v || !v.prompt || v.streaming;
  R.refineChips.replaceChildren(...REFINE_CHIPS[kind]
    .filter(([label]) => !(label === 'Make it a Gem' && s.opts.kind === 'assistant'))
    .map(([label, fb]) => h('button', { class: 'chip small', disabled, onclick: () => doRefine(fb, label) }, label)));
  R.refineInput.disabled = disabled;
  R.refineBtn.disabled = disabled;
  R.refine.hidden = S.tab !== 'prompt' || S.editing;
}

function updateStats() {
  const v = curV();
  if (!v || !R) return;
  const text = v.prompt || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const parts = [
    h('span', {}, h('b', { text: words.toLocaleString() }), ' words'),
    h('span', {}, h('b', { text: text.length.toLocaleString() }), ' characters'),
    h('span', {}, '≈ ', h('b', { text: Math.ceil(text.length / 4).toLocaleString() }), ' tokens'),
  ];
  if (v.model) parts.push(h('span', { text: modelName(v.model) }));
  if (v.ms && !v.streaming) parts.push(h('span', { text: `${(v.ms / 1000).toFixed(1)} s` }));
  if (v.edited) parts.push(h('span', { text: 'edited' }));
  if (v.stopped) parts.push(h('span', { class: 'warn', text: 'stopped early' }));
  R.stats.replaceChildren(...parts);
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!R || S.stage !== 'result') return;
    const follow = nearBottom(R.scroll);
    if (S.tab === 'prompt' && !S.editing) { paintPrompt(); paintSide(); }
    else if (S.tab === 'test') paintTest();
    updateStats();
    if (follow) R.scroll.scrollTop = R.scroll.scrollHeight;
  });
}

// ------------------------------------------------------------------ settings
function setRow(title, desc, ...controls) {
  return h('div', { class: 'set-row' }, h('div', { class: 'what' }, h('b', { text: title }), desc ? h('span', { text: desc }) : null), h('div', { class: 'btn-row' }, controls));
}
const extLink = (label, url) => h('button', { class: 'link', onclick: () => invoke('open_url', { url }).catch(() => {}) }, label, ic('external'));

function renderSettings() {
  const p = $('#settings-page');
  if (!p) return;
  const connected = S.account.connected;
  const chat = chatModels(S.models);
  const imgs = imageModels(S.models);

  const account = h('div', { class: 'card set-card' },
    h('h3', {}, ic('key'), 'Google Gemini account'),
    h('div', { class: `status-line ${connected ? 'on' : 'off'}` }, h('span', { class: 'dot' }), connected ? 'Linked to your Google Gemini account' : 'Not linked yet'),
    connected ? h('div', { class: 'key-mask', text: `API key ${S.account.masked} · stored in Windows Credential Manager` }) : null,
    h('div', { class: 'btn-row' }, connected
      ? [h('button', { class: 'soft', onclick: () => openConnect(true) }, ic('key'), 'Use a different key'),
        h('button', { class: 'ghost', onclick: disconnect }, ic('logout'), 'Unlink')]
      : h('button', { class: 'primary', onclick: () => openConnect() }, ic('link'), 'Link your account')),
    h('div', { class: 'links' },
      extLink('Manage API keys', 'https://aistudio.google.com/apikey'),
      extLink('Usage & limits', 'https://aistudio.google.com/usage'),
      extLink('Gemini API pricing', 'https://ai.google.dev/gemini-api/docs/pricing')));

  const modelSel = h('select', {
    disabled: !chat.length,
    onchange: (e) => { S.settings.model = e.target.value; saveSettings(); renderAccountChip(); renderGoButton(); },
  }, chat.length ? chat.map((m) => h('option', { value: m.id }, modelLabel(m))) : h('option', { value: '' }, connected ? 'Loading models…' : 'Link your account first'));
  if (chat.length) modelSel.value = S.settings.model;
  const imgSel = h('select', {
    disabled: !imgs.length,
    onchange: (e) => { S.settings.imageModel = e.target.value; saveSettings(); },
  }, imgs.map((m) => h('option', { value: m.id }, m.displayName)), h('option', { value: 'none' }, imgs.length ? 'Don\'t test images' : 'None on this key'));
  imgSel.value = imgs.some((m) => m.id === S.settings.imageModel) ? S.settings.imageModel : 'none';
  const sendSel = h('select', { onchange: (e) => { S.settings.sendMode = e.target.value; saveSettings(); } },
    h('option', { value: 'send' }, 'Type it in and send it'),
    h('option', { value: 'insert' }, 'Just type it in (I press Enter)'));
  sendSel.value = S.settings.sendMode;

  const models = h('div', { class: 'card set-card' },
    h('h3', {}, ic('spark'), 'Gemini'),
    setRow('Model', 'Writes your prompts and test runs. Flash is fast with generous limits; Pro is the smartest.', modelSel,
      h('button', { class: 'ghost icon-only', title: 'Reload the model list', disabled: !connected, onclick: () => loadModels().then(() => toast('Model list updated', 'info', 1500)) }, ic('refresh'))),
    setRow('Image test runs', 'Model used when you test an image prompt.', imgSel));

  const siteRows = Object.keys(SITES).map((site) => {
    const on = !!S.sites[site];
    return h('div', { class: 'set-row' },
      h('div', { class: 'what' },
        h('b', {}, site === 'gemini' ? 'Gemini (your Google account)' : SITES[site]),
        h('span', { class: `site-state${on ? ' on' : ''}`, text: on ? 'Signed in' : 'Not signed in yet' })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'soft', onclick: () => openSite(site) }, ic(on ? 'external' : 'user'), on ? 'Open' : 'Sign in'),
        h('button', { class: 'ghost', title: `Sign out of ${SITES[site]} in this app`, onclick: () => signOutSite(site) }, ic('logout'), 'Sign out')));
  });
  const accounts = h('div', { class: 'card set-card' },
    h('h3', {}, ic('user'), 'AI accounts'),
    h('p', { class: 'muted', style: 'margin:0', text: 'Each one opens in a window inside this app. Sign in once and the app remembers it. “Send to …” types your prompt into a new chat there.' }),
    siteRows,
    setRow('“Send to …” should…', 'For Gemini, ChatGPT and Claude.', sendSel));

  const data = h('div', { class: 'card set-card' },
    h('h3', {}, ic('folder'), 'Your data'),
    setRow('Library', `${S.library.length} saved prompt${S.library.length === 1 ? '' : 's'}, kept on this PC.`,
      h('button', { class: 'soft', onclick: exportLibrary, disabled: !S.library.length }, ic('download'), 'Export'),
      h('button', { class: 'ghost', onclick: clearLibrary, disabled: !S.library.length }, ic('trash'), 'Delete all')),
    setRow('Data folder', S.info.dataDir || '', h('button', { class: 'soft', onclick: () => invoke('open_data_dir').catch((e) => toast(normErr(e).message, 'err')) }, ic('folder'), 'Open folder')));

  const about = h('div', { class: 'card set-card' },
    h('h3', {}, h('span', { style: 'width:20px;height:20px;display:block', html: logo() }), `Super Prompt Creator ${S.info.version ? `v${S.info.version}` : ''}`),
    h('p', { class: 'muted', style: 'margin:0', text: 'Your prompts and settings stay on this PC. Requests go straight from this app to Google’s Gemini API with your own key — no other servers involved. Shortcuts: Ctrl+Enter create · Esc stop · Ctrl+Shift+C copy · Ctrl+1/2 switch pages.' }));

  p.replaceChildren(h('header', { class: 'page-head' }, h('div', {}, h('h2', { text: 'Settings' }), h('p', { class: 'sub', text: 'Your Gemini link, AI accounts, models and data.' }))), account, accounts, models, data, about);
}

async function exportLibrary() {
  try {
    const path = await invoke('export_text', { suggestedName: 'super-prompt-library', content: JSON.stringify(S.library, null, 2), ext: 'json' });
    if (path) toast(`Saved to ${path}`, 'ok', 4500);
  } catch (e) { toast(normErr(e).message, 'err'); }
}

async function clearLibrary() {
  const ok = await modal({
    title: 'Delete every saved prompt?',
    body: `All ${S.library.length} prompts in your library will be deleted. This can't be undone (export them first if you want a copy).`,
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete all', value: true, class: 'danger' }],
  });
  if (!ok) return;
  S.library = [];
  saveLibrary();
  renderSettings();
  toast('Library cleared');
}

// ------------------------------------------------------------------ navigation & wiring
function setView(v) {
  S.view = v;
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === `view-${v}`));
  $$('.rail-btn[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === v));
  if (v === 'library') { renderLibrary(); $('#lib-search').focus(); }
  if (v === 'settings') {
    renderSettings();
    refreshSites().then(() => { if (S.view === 'settings') renderSettings(); });
  }
}

function wire() {
  $$('[data-icon]').forEach((el) => el.replaceWith(ic(el.dataset.icon)));
  $$('[data-logo]').forEach((el) => { el.innerHTML = logo(); });

  $$('.rail-btn[data-nav]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.nav)));
  $$('.rail-btn[data-site]').forEach((b) => b.addEventListener('click', () => openSite(b.dataset.site)));
  // Coming back from a site window: pick up a fresh sign-in.
  window.addEventListener('focus', debounce(() => {
    refreshSites().then(() => { if (S.view === 'settings' && $('#modal').hidden) renderSettings(); });
  }, 300));
  $('#account-chip').addEventListener('click', () => (S.account.connected ? setView('settings') : openConnect()));

  $$('.seg-mode button').forEach((b) => b.addEventListener('click', () => {
    if (S.mode === b.dataset.mode) return;
    S.mode = b.dataset.mode;
    renderComposer();
    $('#idea').focus();
  }));
  $('#kind-select').addEventListener('change', (e) => { S.draft.kind = e.target.value; persistDraft(); renderComposer(); });
  $('#media-select').addEventListener('change', (e) => {
    if (TARGETS[S.draft.target].kind === 'image') S.draft.imageModel = e.target.value; else S.draft.videoModel = e.target.value;
    persistDraft();
  });
  for (const [id, key] of [['opt-ask', 'askFirst'], ['opt-blanks', 'blanks'], ['opt-examples', 'examples'], ['opt-aiasks', 'aiAsks']]) {
    $(`#${id}`).addEventListener('change', (e) => { S.draft[key] = e.target.checked; persistDraft(); renderGoButton(); });
  }
  const idea = $('#idea');
  idea.addEventListener('input', () => { S.draft.idea = idea.value; autosize(idea); updateIdeaCount(); });
  $('#idea-clear').addEventListener('click', () => { setIdea(''); idea.focus(); });
  $('#go').addEventListener('click', onGo);

  $('#connect-close').addEventListener('click', closeConnect);
  $('#connect-open').addEventListener('click', () => {
    S.settings.sitesOpened.gemini = true; // signing in to Google here also signs in the Gemini window
    saveSettings();
    invoke('site_open', { target: 'aistudio' }).catch((e) => toast(normErr(e).message, 'err'));
  });
  $('#connect-browser').addEventListener('click', () => invoke('open_url', { url: 'https://aistudio.google.com/apikey' }).catch(() => {}));
  $('#connect-form').addEventListener('submit', submitKey);

  $('#lib-search').addEventListener('input', debounce((e) => { S.libQuery = e.target.value; renderLibrary(); }, 120));

  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!$('#modal').hidden) return;
    if (e.key === 'Escape') {
      if (!$('#connect').hidden) { closeConnect(); return; }
      if (S.busy) { e.preventDefault(); stopAll(); return; }
      if (S.editing) { toggleEdit(); return; }
    }
    if (ctrl && e.key === 'Enter') {
      if (!$('#connect').hidden) return;
      if (S.view !== 'create') return;
      e.preventDefault();
      if (document.activeElement === (R && R.refineInput)) { doRefine(R.refineInput.value); return; }
      if (S.stage === 'interview' && S.interview && document.activeElement !== idea) { runGenerate(collectAnswers(), S.interview.opts); return; }
      onGo();
      return;
    }
    if (ctrl && e.shiftKey && (e.key === 'C' || e.key === 'c') && S.view === 'create' && S.stage === 'result') { e.preventDefault(); copyPrompt(); return; }
    if (ctrl && e.key === '1') { e.preventDefault(); setView('create'); }
    if (ctrl && e.key === '2') { e.preventDefault(); setView('library'); }
    if (ctrl && e.key === ',') { e.preventDefault(); setView('settings'); }
  });
  // Plain links never navigate the app window.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && !a.classList.contains('ext')) e.preventDefault();
  });
  window.addEventListener('resize', debounce(() => autosize(idea), 100));
}

// ------------------------------------------------------------------ boot
function mergeSettings(saved) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const k of ['model', 'imageModel', 'sendMode']) if (typeof saved[k] === 'string') out[k] = saved[k];
    if (saved.draft && typeof saved.draft === 'object') {
      for (const k of Object.keys(DEFAULT_DRAFT)) if (typeof saved.draft[k] === typeof DEFAULT_DRAFT[k]) out.draft[k] = saved.draft[k];
    }
    if (saved.sitesOpened && typeof saved.sitesOpened === 'object') {
      for (const k of Object.keys(out.sitesOpened)) if (typeof saved.sitesOpened[k] === 'boolean') out.sitesOpened[k] = saved.sitesOpened[k];
    }
  }
  if (!TARGETS[out.draft.target]) out.draft.target = 'gemini';
  return out;
}

async function boot() {
  wire();
  try { S.info = await invoke('app_info'); } catch { /* not fatal */ }
  try {
    const raw = await invoke('store_read', { name: 'settings' });
    if (raw) S.settings = mergeSettings(JSON.parse(raw));
  } catch (e) { console.warn('settings', e); }
  try {
    const raw = await invoke('store_read', { name: 'library' });
    const lib = raw ? JSON.parse(raw) : [];
    if (Array.isArray(lib)) S.library = lib.filter((e) => e && e.id && Array.isArray(e.versions) && e.versions.length);
  } catch (e) { console.warn('library', e); }
  S.draft = { ...DEFAULT_DRAFT, ...S.settings.draft, idea: '' };
  try { S.account = await invoke('gemini_status'); } catch { /* keep default */ }
  renderComposer();
  renderStage();
  renderAccountChip();
  updateIdeaCount();
  if (S.account.connected) {
    loadModels();
    $('#idea').focus();
  } else {
    openConnect();
  }
  // Show the window only once the first frame is drawn (no white flash).
  requestAnimationFrame(() => requestAnimationFrame(() => invoke('app_ready').catch(() => {})));
  refreshSites();
}

boot();
