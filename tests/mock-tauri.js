// Browser-pane test harness: stands in for the Rust backend (window.__TAURI__)
// and fakes Gemini's streaming replies, so the UI can be exercised without a key.
// Query flags: ?linked (start linked) · ?autolink (clipboard watcher "finds" a key after 1.5 s)
//              ?signedin=gemini,chatgpt,claude (those sites count as signed in) · ?slow · ?fast
(() => {
  const params = new URLSearchParams(location.search);
  const calls = [];
  window.__mockCalls = calls;
  const KEY = 'spc-mock-';
  const signedIn = (params.get('signedin') || '').split(',');
  const mem = {
    linked: params.has('linked'),
    masked: 'AIza••••••••Mock',
    cancels: new Set(),
    // ?signedin=gemini,chatgpt simulates sites already signed in inside the app
    signedIn: { gemini: signedIn.includes('gemini'), chatgpt: signedIn.includes('chatgpt'), claude: signedIn.includes('claude') },
  };
  window.__mock = mem;

  const MODELS = [
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
    ['gemini-flash-latest', 'Gemini Flash Latest'], ['gemini-3-pro-preview', 'Gemini 3 Pro Preview'],
    ['gemini-2.5-flash-image', 'Nano Banana'], ['gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS'],
    ['gemini-embedding-001', 'Gemini Embedding'], ['gemma-3-27b-it', 'Gemma 3 27B'],
    ['gemini-2.5-flash-native-audio-preview', 'Gemini 2.5 Flash Native Audio'],
  ].map(([id, displayName]) => ({
    id, displayName, description: '', inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true,
    methods: id.includes('embedding') ? ['embedContent'] : ['generateContent', 'countTokens'],
  }));

  class Channel { constructor() { this.onmessage = () => {}; } }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (kind, message) => ({ kind, message });

  function userText(body) {
    const c = body.contents || [];
    const last = c[c.length - 1];
    return (last && last.parts && last.parts[0] && last.parts[0].text) || '';
  }
  function ideaOf(body) {
    const first = (body.contents && body.contents[0] && body.contents[0].parts[0].text) || '';
    const m = first.match(/<(?:idea|prompt)>\n([\s\S]*?)\n<\/(?:idea|prompt)>/);
    return m ? m[1] : first;
  }

  function cannedText(body) {
    const sys = (body.systemInstruction && body.systemInstruction.parts[0].text) || '';
    const idea = ideaOf(body);
    const ut = userText(body);
    const revised = /^Revise the super prompt/.test(ut);
    const rev = revised ? `\n\n(Revised: ${ut.split('\n')[0].replace('Revise the super prompt based on this feedback: ', '')})` : '';
    if (!sys) {
      // A test run of the super prompt itself.
      return `## Your 12-week plan\n\nHere's a plan built from your prompt.\n\n| Week | Focus | Daily time |\n|---|---|---|\n| 1–2 | Sounds, greetings, numbers | 30 min |\n| 3–6 | Present tense, everyday phrases | 40 min |\n| 7–12 | Past tense, conversation practice | 45 min |\n\n### How to use it\n1. **Start small** — 15 minutes of vocab with spaced repetition.\n2. Speak out loud every day; record yourself.\n   - Shadow short podcast clips\n   - Write 3 sentences about your day\n3. Review on Sundays.\n\n\`\`\`python\nprint("¡Hola, mundo!")\n\`\`\`\n\n> Consistency beats intensity.\n\nMore help: [Spanish resources](https://example.com/spanish) or https://example.org/path.`;
    }
    if (/image generators/.test(sys)) {
      return `A matte black coffee bag stands upright on a white Carrara marble counter, its paper texture catching soft morning light that pours in from a window on the left. Steam curls from a ceramic cup beside it; a few roasted beans are scattered in the foreground, slightly out of focus. Shot at eye level with an 85mm lens at f/2.8, shallow depth of field, warm neutral palette with deep blacks and creamy highlights, clean minimalist product photography with a premium, calm mood. The label reads "{{BRAND_NAME}}" in small gold serif lettering.${rev}\nAspect ratio: 4:5\n\n---NOTES---\nTitle: Matte Coffee Bag Morning Shot\n- Swap the marble for walnut wood for a warmer look.\n- Try 1:1 for Instagram posts.`;
    }
    if (/video generators/.test(sys)) {
      return `Shot 1 (0–3 s): Night, a lone lighthouse on a black rock, sweeping beam cutting through sheets of rain; wide shot, camera slowly pushing in.\nShot 2 (3–6 s): A massive wave explodes against the rocks below the tower, spray caught in the beam; low angle, handheld shake.\nShot 3 (6–8 s): Close on the lamp room glass streaked with water, the beam rotating past the lens.\nAudio: howling wind, crashing surf, a deep foghorn every few seconds.${rev}\n\n---NOTES---\nTitle: Lighthouse In The Storm\n- Ask for 8 seconds to keep all three beats.\n- Add "cinematic color grade" for a filmic look.`;
    }
    const improving = /already use/.test(sys);
    const notes = improving
      ? '- Added a clear role and audience.\n- Spelled out the exact output format.\n- Removed vague words like "good".'
      : '- Fill in {{CURRENT_LEVEL}} before you send it.\n- Ask for a weekly check-in to keep it adaptive.';
    return `## Role
You are an experienced language coach who designs realistic self-study plans for busy adults.

## Context
The learner wants: ${idea.trim()}. They study alone, at home, around a full-time job. Their current level is {{CURRENT_LEVEL}}.

## Task
Create a 12-week study plan that takes them from their current level to holding simple everyday conversations.

## Approach
1. Split the 12 weeks into three phases with a clear goal each.
2. Give every week a focus, 5 daily activities and one weekend review.
3. Mix input (listening, reading) with output (speaking, writing) every day.

## Requirements
- Use **free** resources wherever possible.
- Keep daily study between 30 and 45 minutes.
- Do not assume a tutor or classes.

## Output format
A table per phase (Week | Focus | Daily activities | Weekend review), then a short list of tips.

## Before you answer
- Is every week realistic for 30–45 minutes a day?
- Does each phase build on the last?${rev}

---NOTES---
Title: ${improving ? 'Sharper Study Plan Prompt' : '12-Week Spanish Study Plan'}
${notes}`;
  }

  const TINY_PNG = (() => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 400;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 320, 400);
    grad.addColorStop(0, '#2b2b2b'); grad.addColorStop(1, '#e8e2d9');
    g.fillStyle = grad; g.fillRect(0, 0, 320, 400);
    g.fillStyle = '#111'; g.fillRect(110, 110, 100, 170);
    g.fillStyle = '#c9a54a'; g.font = '16px serif'; g.fillText('MOCK', 136, 200);
    return c.toDataURL('image/png').split(',')[1];
  })();

  async function stream({ requestId, body, onEvent, model }) {
    const send = (ev) => onEvent.onmessage(ev);
    const idea = ideaOf(body) + userText(body);
    await sleep(params.has('slow') ? 2500 : 600);
    if (/#err429/.test(idea)) { send({ type: 'error', ...err('quota', "Gemini's rate limit for your key was hit. Wait about 37 seconds and try again, or switch to a Flash model.") }); return; }
    if (/#errnet/.test(idea)) { send({ type: 'error', ...err('network', "Can't reach Google's servers. Check your internet connection (or VPN / proxy).") }); return; }
    if (/#blocked/.test(idea)) { send({ type: 'done', finishReason: 'SAFETY', blockReason: 'SAFETY' }); return; }
    const wantsImage = body.generationConfig && (body.generationConfig.responseModalities || []).includes('IMAGE');
    if (wantsImage) {
      send({ type: 'delta', text: 'Here is your image.' });
      await sleep(400);
      send({ type: 'image', mimeType: 'image/png', data: TINY_PNG });
      send({ type: 'done', finishReason: 'STOP', modelVersion: model });
      return;
    }
    const text = cannedText(body);
    for (let i = 0; i < text.length; i += 18) {
      if (mem.cancels.has(requestId)) { send({ type: 'done', finishReason: 'CANCELLED' }); return; }
      send({ type: 'delta', text: text.slice(i, i + 18) });
      if (/#errmid/.test(idea) && i > 300) { send({ type: 'error', ...err('server', 'Gemini is overloaded right now. Try again in a moment, or switch to another model.') }); return; }
      await sleep(params.has('fast') ? 2 : 22);
    }
    send({ type: 'done', finishReason: 'STOP', modelVersion: model, usage: { totalTokenCount: 900 } });
  }

  const handlers = {
    app_ready: () => null,
    app_info: () => ({ version: '1.0.0', test: true, dataDir: 'C:\\Users\\you\\AppData\\Roaming\\com.superprompt.creator', customApi: false }),
    store_read: ({ name }) => localStorage.getItem(KEY + name),
    store_write: ({ name, data }) => { JSON.parse(data); localStorage.setItem(KEY + name, data); return null; },
    gemini_status: () => ({ connected: mem.linked, masked: mem.linked ? mem.masked : '' }),
    gemini_connect: async ({ key }) => {
      await sleep(500);
      if (!/^AIza[\w-]{35}$/.test(key.trim())) throw err('auth', "Google says this API key isn't valid. Copy the whole key from Google AI Studio and link it again.");
      mem.linked = true;
      return { masked: key.slice(0, 4) + '••••••••' + key.slice(-4), models: MODELS };
    },
    gemini_disconnect: () => { mem.linked = false; return null; },
    gemini_models: async () => { if (!mem.linked) throw err('auth', 'Link your Google Gemini account first.'); await sleep(200); return MODELS; },
    gemini_generate: async ({ body }) => {
      await sleep(700);
      if (/#errq/.test(JSON.stringify(body))) throw err('quota', "You've used today's Gemini requests for this model on your key.");
      const questions = [
        { question: 'What is your current level?', options: ['Total beginner', 'A little', 'Intermediate'] },
        { question: 'How much time can you study each day?', options: ['15 minutes', '30 minutes', '1 hour+'] },
        { question: 'What is the main goal?', options: ['Travel', 'Work', 'Family', 'Exams'] },
      ];
      return { candidates: [{ content: { parts: [{ text: JSON.stringify({ questions }) }] } }] };
    },
    gemini_stream: (args) => stream(args),
    gemini_cancel: ({ requestId }) => { mem.cancels.add(requestId); return null; },
    key_watch_start: ({ onEvent }) => {
      if (params.has('autolink')) {
        setTimeout(() => onEvent.onmessage({ type: 'found' }), 1500);
        setTimeout(() => { mem.linked = true; onEvent.onmessage({ type: 'linked', masked: 'AIza••••••••Auto', models: MODELS }); }, 2600);
      }
      return null;
    },
    key_watch_stop: () => null,
    clipboard_write: ({ text }) => { window.__mockClipboard = text; return null; },
    open_url: () => null,
    open_data_dir: () => null,
    export_text: ({ suggestedName }) => `C:\\Users\\you\\Documents\\${suggestedName}.md`,
    site_open: ({ target }) => { if (!['aistudio', 'gems', 'gemini', 'chatgpt', 'claude'].includes(target)) throw `Unknown site '${target}'.`; return null; },
    site_close: () => null,
    chat_send: ({ site, text }) => {
      if (!['gemini', 'chatgpt', 'claude'].includes(site)) throw `Unknown site '${site}'.`;
      if (!text.trim()) throw "There's nothing to send yet.";
      return null;
    },
    sites_status: () => ({ ...mem.signedIn }),
    site_signout: ({ site }) => { mem.signedIn[site] = false; return 3; },
  };

  window.__TAURI__ = {
    core: {
      Channel,
      invoke: async (cmd, args = {}) => {
        calls.push({ cmd, args: { ...args, onEvent: undefined } });
        const fn = handlers[cmd];
        if (!fn) throw `mock: unknown command ${cmd}`;
        return fn(args);
      },
    },
  };
})();
