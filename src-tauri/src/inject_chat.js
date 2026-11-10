// Runs inside Gemini / ChatGPT / Claude (the app's in-app windows) when the user
// clicks "Send to …". It only types the user's prompt into the site's message
// box and, if asked, presses Send. No innerHTML (these sites use Trusted Types).
(() => {
  const SITE = __SPC_SITE__;
  const TEXT = __SPC_TEXT__;
  const AUTO_SEND = __SPC_AUTO__;
  const NONCE = __SPC_NONCE__;
  const NAME = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude' }[SITE] || 'the chat';
  const DONE_KEY = 'spc-typed-' + NONCE;
  const WAIT_MS = 45000;
  const started = Date.now();

  // The app re-sends the prompt after reloads for a short while; never type it twice.
  try { if (sessionStorage.getItem(DONE_KEY)) return; } catch (e) { /* storage blocked */ }
  if (window.__spcRunning === NONCE) return;
  window.__spcRunning = NONCE;
  const markDone = () => { try { sessionStorage.setItem(DONE_KEY, '1'); } catch (e) { /* ignore */ } };

  const BOX = {
    gemini: ['rich-textarea .ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    chatgpt: ['#prompt-textarea[contenteditable="true"]', 'div#prompt-textarea', 'form .ProseMirror[contenteditable="true"]', 'textarea#prompt-textarea'],
    claude: ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][aria-label*="prompt" i]', 'fieldset [contenteditable="true"]'],
  }[SITE] || [];
  const ANY_BOX = ['[contenteditable="true"][role="textbox"]', '.ProseMirror[contenteditable="true"]', 'textarea[aria-label]', 'textarea'];
  const SEND = {
    gemini: ['button.send-button', 'button[aria-label*="Send" i]'],
    chatgpt: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send" i]'],
    claude: ['button[aria-label*="Send" i]', 'fieldset button[type="submit"]'],
  }[SITE] || ['button[aria-label*="Send" i]'];

  function toast(msg, ok) {
    try {
      let el = document.getElementById('spc-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'spc-toast';
        document.documentElement.appendChild(el);
      }
      el.textContent = msg;
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:110px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'pointer-events:none', 'max-width:80vw', 'text-align:center',
        'font:600 14px/1.4 "Segoe UI",system-ui,sans-serif', 'color:#fff',
        'padding:10px 18px', 'border-radius:14px', 'box-shadow:0 10px 30px rgba(0,0,0,.35)',
        'background:' + (ok ? 'linear-gradient(135deg,#ff7a3d,#ff4d8d 55%,#7c5cff)' : '#991b1b'),
        'transition:opacity .5s', 'opacity:1',
      ].join(';');
      clearTimeout(el._spcTimer);
      el._spcTimer = setTimeout(() => { el.style.opacity = '0'; }, 4500);
    } catch (e) { /* page changed under us */ }
  }

  const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
  function first(selectors) {
    for (const s of selectors) {
      for (const el of document.querySelectorAll(s)) if (visible(el)) return el;
    }
    return null;
  }
  const findBox = () => first(BOX) || first(ANY_BOX);
  const boxText = (el) => ((el.tagName === 'TEXTAREA' ? el.value : el.innerText) || '').trim();
  const typedEnough = (el) => boxText(el).length >= Math.min(20, TEXT.trim().length);

  function selectAll(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insert(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, TEXT);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    selectAll(el);
    try { document.execCommand('insertText', false, TEXT); } catch (e) { /* fall through */ }
    if (typedEnough(el)) return;
    // Fallback: a synthetic paste, which rich editors (Quill, ProseMirror) turn into proper lines.
    try {
      selectAll(el);
      const dt = new DataTransfer();
      dt.setData('text/plain', TEXT);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
  }

  function findSend() {
    for (const s of SEND) {
      for (const b of document.querySelectorAll(s)) {
        if (visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
      }
    }
    return null;
  }

  function trySend(triesLeft) {
    const b = findSend();
    if (b) {
      b.click();
      toast('Super prompt sent to ' + NAME + ' ✓', true);
      return;
    }
    if (triesLeft > 0) { setTimeout(() => trySend(triesLeft - 1), 250); return; }
    toast('Super prompt typed in — press Enter to send', true);
  }

  (function attempt() {
    const el = findBox();
    if (!el) {
      if (Date.now() - started < WAIT_MS) { setTimeout(attempt, 500); return; }
      window.__spcRunning = null;
      toast('Sign in to ' + NAME + ', then click Send again — or press Ctrl+V to paste your prompt.', false);
      return;
    }
    insert(el);
    setTimeout(() => {
      if (!typedEnough(el)) {
        window.__spcRunning = null;
        toast("Couldn't type it in automatically — press Ctrl+V to paste your prompt.", false);
        return;
      }
      markDone();
      if (AUTO_SEND) trySend(16);
      else toast('Super prompt typed in — press Enter to send', true);
    }, 400);
  })();
})();
