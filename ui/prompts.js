// The prompt engine: what Super Prompt Creator asks Gemini to do.
// Everything here is plain data + string building, so it is easy to tune.

export const TARGETS = {
  gemini: { label: 'Gemini', kind: 'text', name: 'Google Gemini',
    tip: 'Gemini can read uploaded files, images and long documents and can use Google Search. When the task depends on the person\'s own files or on current facts, tell it to use them.' },
  chatgpt: { label: 'ChatGPT', kind: 'text', name: 'ChatGPT',
    tip: 'ChatGPT can browse the web, read uploaded files and run code. Mention these only when the task needs them.' },
  claude: { label: 'Claude', kind: 'text', name: 'Claude',
    tip: 'Claude follows long, structured instructions closely. Put any material the person will paste inside XML tags such as <document>…</document>.' },
  any: { label: 'Any AI', kind: 'text', name: 'any modern AI assistant',
    tip: 'Keep it model-agnostic: do not rely on features only one product has.' },
  image: { label: 'Image', kind: 'image', name: 'an AI image generator' },
  video: { label: 'Video', kind: 'video', name: 'an AI video generator' },
};

export const TEXT_TYPES = [
  ['auto', 'Auto-detect'],
  ['task', 'Task or question'],
  ['writing', 'Writing & content'],
  ['coding', 'Coding & tech'],
  ['research', 'Research & analysis'],
  ['learning', 'Learning & tutoring'],
  ['business', 'Business & marketing'],
  ['creative', 'Creative & stories'],
  ['roleplay', 'Character & roleplay'],
  ['assistant', 'Reusable assistant (Gem)'],
];

export const IMAGE_MODELS = [
  ['gemini', 'Gemini / Imagen'],
  ['midjourney', 'Midjourney'],
  ['chatgpt', 'ChatGPT images'],
  ['sd', 'Stable Diffusion / Flux'],
];

export const VIDEO_MODELS = [
  ['veo', 'Veo (Gemini)'],
  ['sora', 'Sora'],
  ['other', 'Runway / Kling / other'],
];

export const DETAILS = [
  ['concise', 'Concise'],
  ['balanced', 'Balanced'],
  ['maximum', 'Maximum'],
];

const TYPE_GUIDE = {
  task: 'A one-off task or question. Pin down the precise objective, the inputs the AI will work from, and exactly what it should hand back.',
  writing: 'Writing or content. Specify the audience, purpose, voice and tone, structure and length, and what to avoid (clichés, filler, generic phrasing). Ask for a strong opening and, where it fits, a clear call to action.',
  coding: 'Coding. Specify the language and versions, frameworks, environment and constraints. Ask for complete, runnable code (never "…rest of the code here"), sensible error handling, a short explanation of key decisions, and how to run or test it. If the person will paste their own code or error, leave a clearly marked place for it.',
  research: 'Research or analysis. Specify the question, scope, time frame and the kinds of sources to prefer. Tell the AI to separate facts from estimates, to say when it is unsure, and never to invent facts, numbers or citations. Ask for the answer first, then the supporting findings, then sources and limitations.',
  learning: 'Learning or tutoring. Specify the learner\'s level and goal. Ask for explanations that build up step by step, with analogies and worked examples, short checks for understanding, and adjustment based on the learner\'s answers.',
  business: 'Business or marketing. Specify the product or offer, the target customer, the goal and how success is measured, the channel, brand voice and constraints. Ask for a few options plus a recommended pick with reasoning.',
  creative: 'Creative work or storytelling. Specify genre, tone, point of view, length, characters, setting and themes. Push for vivid, specific detail and an original take, and rule out clichés.',
  roleplay: 'Character or roleplay. Define the character\'s identity, personality, way of speaking, knowledge, goals and limits; how to stay in character; how to open the conversation; and how long replies should be.',
  assistant: 'A reusable assistant: a Gemini Gem, a custom GPT or a system prompt that will be used across many conversations, so write standing instructions rather than a one-off task.',
};

const TEXT_SECTIONS = `Format the prompt in Markdown with "## " headings, in this order, leaving out any section that would add nothing:
- Role: the expertise and perspective the AI should take on
- Context: background, audience, situation and why it matters
- Task: the objective, in one to three sentences
- Approach: numbered steps the AI should follow
- Requirements: must / must-not rules, scope, length, tone and style
- Output format: the exact shape of the answer (sections, tables, word counts, code blocks…)
- Examples: only if they clearly help
- Before you answer: a short self-check list`;

const ASSISTANT_SECTIONS = `Format the instructions in Markdown with "## " headings, in this order, leaving out any section that would add nothing:
- Identity & purpose
- What you help with
- How you work: step by step, including when to ask the user questions
- Style & tone
- Default output format
- Boundaries: what to avoid and how to handle requests outside the purpose
- Example exchange: one short example of a user message and an ideal reply`;

const DETAIL_TEXT = {
  concise: 'Keep it tight: about 120–250 words, only the sections that matter most.',
  balanced: 'Aim for about 250–500 words.',
  maximum: 'Be thorough: typically 500–1,000 words, rich with specifics, but never padded.',
};
const DETAIL_MEDIA = {
  concise: 'Keep it short and punchy.',
  balanced: 'Use a moderate amount of detail.',
  maximum: 'Use rich, precise detail.',
};

const IMAGE_FORMAT = {
  gemini: 'Write one or two vivid paragraphs (60–180 words) that describe the image as a scene, in natural sentences rather than keyword lists. If text must appear in the image, give the exact words in quotes and describe the lettering. End with a separate line: "Aspect ratio: W:H".',
  midjourney: 'Write a single line: a concise scene description first (most important elements first), then style, medium, lighting and composition phrases, then Midjourney parameters such as --ar W:H, --stylize N and --no <things to exclude>. No markdown and no line breaks.',
  chatgpt: 'Write one or two descriptive paragraphs in natural sentences. Put any exact text to render in quotes. End with a separate line: "Aspect ratio: W:H".',
  sd: 'Use three labelled lines. "Prompt:" comma-separated descriptive phrases ordered by importance (subject, details, setting, style, lighting, camera, quality). "Negative prompt:" what to avoid. "Settings:" the aspect ratio and, optionally, suggested steps and CFG scale.',
};
const IMAGE_NAMES = {
  gemini: 'Google Gemini image generation (Imagen / "Nano Banana")',
  midjourney: 'Midjourney',
  chatgpt: 'ChatGPT image generation',
  sd: 'Stable Diffusion / Flux',
};
const VIDEO_NOTE = {
  veo: 'Veo creates short clips with native sound, so describe dialogue (in quotes), sound effects and ambience.',
  sora: 'Sora handles longer, multi-shot scenes with sound, so describe each shot and the audio.',
  other: 'Keep each clip to one clear shot of about 5–10 seconds; sound may not be supported, so focus on visuals.',
};
const VIDEO_NAMES = { veo: 'Google Veo', sora: 'OpenAI Sora', other: 'AI video generators such as Runway or Kling' };

const NOTES_TAIL = (tips) => `After the prompt, write a line containing exactly ---NOTES--- and then:
Title: <a 3–6 word title for this prompt>
${tips}`;

function textSystem(o, improving) {
  const t = TARGETS[o.target] || TARGETS.gemini;
  const assistant = o.kind === 'assistant';
  const typeLine = o.kind && o.kind !== 'auto'
    ? `Prompt type: ${TYPE_GUIDE[o.kind]}`
    : 'Prompt type: decide what kind of prompt this is (a one-off task, writing, coding, research, learning, business, creative, roleplay or a reusable assistant) and bring the matching expertise.';
  const blanks = o.blanks
    ? 'For information only the person can supply (their own details, a document to paste, a specific name), insert a blank such as {{PRODUCT_NAME}}: UPPER_SNAKE_CASE inside double curly braces, at most 5 blanks, each placed exactly where the value belongs. Never use a blank for something you can reasonably decide.'
    : 'Do not leave blanks. Make reasonable assumptions instead, and state them in the prompt where they matter.';
  const examples = o.examples
    ? 'Include a short "## Examples" section with one or two concrete examples of the desired output (or input → output pairs).'
    : 'Include examples only if the task is hard to specify without them.';
  const lines = [
    improving
      ? `You are Super Prompt Creator, an expert prompt engineer. The person gives you a prompt they already use. Rewrite it into a much stronger "super prompt" for ${t.name}, keeping their intent, facts, names and requirements.`
      : `You are Super Prompt Creator, an expert prompt engineer. You turn a person's rough idea into one complete, ready-to-paste prompt (a "super prompt") that gets an excellent result from ${t.name} on the first try.`,
    '',
    'How to think (do not write this part out):',
    improving
      ? '1. Find what holds the original back: a vague goal, missing context or audience, no clear output format, conflicting or buried instructions, filler.'
      : '1. Work out the real goal, the deliverable, who it is for, and what an excellent result would look like.',
    '2. Use every detail and answer the person gave. Where something is missing, choose a sensible default' + (o.blanks ? ', or insert a blank only for information you truly cannot assume.' : '.'),
    '3. Write what a top expert in this field would write: specific, concrete and unambiguous. Every line must change the result. No filler, no hype words ("ultimate", "world-class"), and no talk about prompts or AI inside the prompt unless it serves the task.',
    '',
    typeLine,
    '',
    assistant ? ASSISTANT_SECTIONS : TEXT_SECTIONS,
    '',
    'Rules:',
    `- ${DETAIL_TEXT[o.detail] || DETAIL_TEXT.balanced}`,
    '- Write the prompt in the same language as the person\'s idea.',
    `- Speak to the AI directly in the second person ("You are…", "Write…").`,
    `- ${blanks}`,
    `- ${examples}`,
  ];
  if (o.aiAsks && !assistant) lines.push('- Begin the prompt by telling the AI to first ask the person up to 3 short clarifying questions, wait for the answers, and only then do the task.');
  lines.push(`- ${t.tip}`);
  lines.push('- Output only the prompt: no title line, no introduction, no closing remarks, and never wrap it in a code block.');
  lines.push('');
  lines.push(NOTES_TAIL(improving
    ? '- 3 to 5 short bullets naming the most important improvements you made ("Added…", "Clarified…"), each under 20 words.'
    : '- 2 to 4 short tips for the person (what to fill in, how to use or adapt it), each under 20 words.'));
  return lines.join('\n');
}

function imageSystem(o, improving) {
  const name = IMAGE_NAMES[o.imageModel] || IMAGE_NAMES.gemini;
  return [
    improving
      ? `You are Super Prompt Creator, an expert at prompts for AI image generators. The person gives you an image prompt they already use. Rewrite it into a far stronger one for ${name}, keeping their subject and intent.`
      : `You are Super Prompt Creator, an expert at prompts for AI image generators. Turn the person's rough idea into one excellent image prompt for ${name}.`,
    '',
    'Make it visual and concrete. Cover the subject (appearance, pose, expression, clothing, materials); the setting and background; composition and framing (shot type, camera angle, lens or focal length for photographic looks); lighting (source, direction, quality, time of day); colour palette and mood; the art style or medium; and the fine details and textures that make it believable. Choose one coherent style instead of stacking contradictory ones, and avoid empty words that do not render ("amazing", "beautiful").',
    '',
    `Format: ${IMAGE_FORMAT[o.imageModel] || IMAGE_FORMAT.gemini}`,
    '',
    'Rules:',
    `- ${DETAIL_MEDIA[o.detail] || DETAIL_MEDIA.balanced}`,
    '- Write the prompt in English (image models follow English best), but write the notes below in the person\'s language.',
    o.blanks ? '- Use a {{BLANK}} only for something the person must supply (for example {{BRAND_NAME}}), at most 3.' : '- Do not use blanks; decide the details yourself.',
    '- Output only the prompt: no introduction, no explanation, no code block.',
    '',
    NOTES_TAIL(improving
      ? '- 3 to 5 short bullets naming the most important improvements, each under 20 words.'
      : '- 2 to 4 short tips (variations to try, settings to tweak), each under 20 words.'),
  ].join('\n');
}

function videoSystem(o, improving) {
  const name = VIDEO_NAMES[o.videoModel] || VIDEO_NAMES.veo;
  return [
    improving
      ? `You are Super Prompt Creator, an expert at prompts for AI video generators. The person gives you a video prompt they already use. Rewrite it into a far stronger one for ${name}, keeping their subject and intent.`
      : `You are Super Prompt Creator, an expert at prompts for AI video generators. Turn the person's rough idea into one excellent video prompt for ${name}.`,
    '',
    `Write like a film director briefing a crew: the subject and the action, beat by beat; the setting; the camera (shot size, angle, and movement such as a slow dolly-in, tracking shot or handheld); lens and depth of field; lighting and mood; visual style; pacing and duration; and audio (dialogue in quotes, sound effects, ambience, music). ${VIDEO_NOTE[o.videoModel] || VIDEO_NOTE.veo}`,
    '',
    'Format: if the idea needs several shots, write a numbered shot list with rough timings ("Shot 1 (0–3 s): …"); otherwise write one or two dense paragraphs (80–200 words). No markdown headings.',
    '',
    'Rules:',
    `- ${DETAIL_MEDIA[o.detail] || DETAIL_MEDIA.balanced}`,
    '- Write the prompt in English (video models follow English best), but write the notes below in the person\'s language.',
    o.blanks ? '- Use a {{BLANK}} only for something the person must supply, at most 3.' : '- Do not use blanks; decide the details yourself.',
    '- Output only the prompt: no introduction, no explanation, no code block.',
    '',
    NOTES_TAIL(improving
      ? '- 3 to 5 short bullets naming the most important improvements, each under 20 words.'
      : '- 2 to 4 short tips (variations to try, what to change between takes), each under 20 words.'),
  ].join('\n');
}

export function systemFor(o, improving) {
  const kind = (TARGETS[o.target] || TARGETS.gemini).kind;
  if (kind === 'image') return imageSystem(o, improving);
  if (kind === 'video') return videoSystem(o, improving);
  return textSystem(o, improving);
}

/** First user message for a new prompt (also replayed when refining). */
export function createUserText(o, answers) {
  const parts = [`Here is my idea:\n<idea>\n${o.idea.trim()}\n</idea>`];
  const answered = (answers || []).filter((a) => a.answer && a.answer.trim());
  if (answered.length) {
    parts.push('My answers to your questions:\n' + answered.map((a) => `- ${a.question} → ${a.answer.trim()}`).join('\n'));
  }
  parts.push('Write the super prompt now.');
  return parts.join('\n\n');
}

export function improveUserText(o) {
  return `Here is the prompt I want improved:\n<prompt>\n${o.idea.trim()}\n</prompt>\n\nRewrite it into a super prompt now.`;
}

export function generationBody(system, contents) {
  return { systemInstruction: { parts: [{ text: system }] }, contents };
}

export function createRequest(o, answers) {
  const userText = createUserText(o, answers);
  return { userText, body: generationBody(systemFor(o, false), [{ role: 'user', parts: [{ text: userText }] }]) };
}

export function improveRequest(o) {
  const userText = improveUserText(o);
  return { userText, body: generationBody(systemFor(o, true), [{ role: 'user', parts: [{ text: userText }] }]) };
}

export function refineRequest(o, improving, firstUserText, lastRaw, feedback) {
  const ask = `Revise the super prompt based on this feedback: ${feedback.trim()}\n\nKeep everything that already works. Return the complete revised prompt in the same format: the prompt, then the ---NOTES--- line, the Title line and the bullets.`;
  return generationBody(systemFor(o, improving), [
    { role: 'user', parts: [{ text: firstUserText }] },
    { role: 'model', parts: [{ text: lastRaw }] },
    { role: 'user', parts: [{ text: ask }] },
  ]);
}

const INTERVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

export function interviewRequest(o) {
  const t = TARGETS[o.target] || TARGETS.gemini;
  const what = t.kind === 'image' ? 'an image prompt' : t.kind === 'video' ? 'a video prompt' : `a prompt for ${t.name}`;
  const system = [
    `You help a person get the best possible ${what}. Read their idea and choose the 2 to 4 questions whose answers would most improve the final prompt: things like the goal, the audience, the format, the length, the style or key specifics.`,
    'Skip anything the idea already answers, and never ask about things that could sensibly be decided without them.',
    'Each question must be short (at most 12 words) and come with 3 or 4 likely answers (at most 5 words each) that the person can tap.',
    'Write in the same language as the idea.',
  ].join('\n');
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: `My idea:\n<idea>\n${o.idea.trim()}\n</idea>` }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: INTERVIEW_SCHEMA },
  };
}

export const REFINE_CHIPS = {
  text: [
    ['Shorter', 'Make it noticeably shorter and tighter without losing anything essential.'],
    ['More detail', 'Make it more detailed and specific, adding depth where it improves the result.'],
    ['More creative', 'Make it more creative and original.'],
    ['Add examples', 'Add one or two concrete examples of the desired output.'],
    ['Simpler words', 'Use simpler, plainer language.'],
    ['More formal', 'Make the tone more formal and professional.'],
    ['Make it a Gem', 'Turn it into standing instructions for a reusable Gemini Gem (a custom assistant used across many conversations).'],
  ],
  image: [
    ['Shorter', 'Make it shorter and punchier.'],
    ['More detail', 'Add more precise visual detail.'],
    ['More cinematic', 'Make it more cinematic: dramatic lighting, composition and lens choices.'],
    ['Different style', 'Keep the subject but switch to a clearly different art style.'],
    ['Photoreal', 'Make it look like a real photograph.'],
  ],
  video: [
    ['Shorter', 'Make it shorter and tighter.'],
    ['More detail', 'Add more precise visual and audio detail.'],
    ['Camera moves', 'Add deliberate, motivated camera movement.'],
    ['Sound design', 'Add rich sound design: ambience, effects and music.'],
    ['Split into shots', 'Split it into a short shot list with timings.'],
  ],
};

export const EXAMPLES = [
  { text: 'Plan a 3-month study schedule to learn Spanish from zero', target: 'gemini', kind: 'learning', icon: 'book' },
  { text: 'Write a cold email to land my first freelance web design client', target: 'chatgpt', kind: 'writing', icon: 'mail' },
  { text: 'A Python script that sorts my photos into folders by the date they were taken', target: 'gemini', kind: 'coding', icon: 'code' },
  { text: 'A Gem that reviews my YouTube video scripts and makes them punchier', target: 'gemini', kind: 'assistant', icon: 'bot' },
  { text: 'Product photo of a matte black coffee bag on a marble counter, soft morning light', target: 'image', imageModel: 'gemini', icon: 'image' },
  { text: 'A lighthouse in a storm at night, huge waves, camera slowly pushing in', target: 'video', videoModel: 'veo', icon: 'video' },
];

export const PLACEHOLDER_TEXT = {
  text: 'Describe what you want the AI to do…\ne.g. Help me write a cover letter for a junior UX designer job at a game studio',
  image: 'Describe the picture you want…\ne.g. A cozy cabin in a snowy forest at dusk, warm light glowing in the windows',
  video: 'Describe the clip you want…\ne.g. A drone shot rising over a misty mountain lake at sunrise',
  improve: 'Paste the prompt you want to improve…',
};

// ---------------------------------------------------------------- parsing

const NOTES_RE = /^[ \t>]*[*_#]*[ \t]*-{2,}[ \t]*NOTES?[ \t]*-{2,}[ \t]*[*_]*[ \t]*$/im;

function stripFence(s) {
  const m = s.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : s;
}

/**
 * Split Gemini's reply into the prompt itself, the tips, and the title.
 * While streaming, a half-written separator line is hidden.
 */
export function splitOutput(raw, streaming) {
  let text = raw.replace(/\r\n?/g, '\n');
  const m = text.match(NOTES_RE);
  let prompt = text;
  let notesRaw = '';
  if (m) {
    prompt = text.slice(0, m.index);
    notesRaw = text.slice(m.index + m[0].length);
  } else if (streaming) {
    // Hide a trailing partial "---NOT" line until it is complete.
    prompt = text.replace(/\n[ \t*_]*-{2,}[ \t]*N?O?T?E?S?[ \t]*-*[ \t*_]*$/i, '\n');
  }
  prompt = stripFence(prompt.trim());
  let title = '';
  const notes = [];
  for (const line of notesRaw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const tm = l.match(/^[*_]*\s*title\s*[*_]*\s*[:：]\s*[*_]*(.+?)[*_]*$/i);
    if (tm && !title) { title = tm[1].replace(/^["“]|["”]$/g, '').trim(); continue; }
    const note = l.replace(/^([-*•]|\d+[.)])\s*/, '').trim();
    if (note) notes.push(note);
  }
  return { prompt, notes, title };
}

export const PH_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ \-]{0,60}?)\s*\}\}/g;

export function placeholders(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(PH_RE)) {
    const name = m[1].trim();
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

export function fillPlaceholders(text, fills) {
  return text.replace(PH_RE, (all, name) => {
    const v = fills && fills[name.trim()];
    return v && v.trim() ? v.trim() : all;
  });
}

export function prettyPlaceholder(name) {
  const s = name.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
