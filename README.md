# Super Prompt Creator

A small Windows app (one EXE, about 5 MB) that turns a rough idea into a detailed, ready-to-use
"super prompt" using **your own Google Gemini account**, and then sends it to **Gemini, ChatGPT or
Claude**, each signed in with your own account inside the app.

![icon](src-tauri/icons/128x128.png)

## Run it

Download **`SuperPromptCreator.exe`** from the [latest release](../../releases/latest) and
double-click it. Nothing to install. It needs the Microsoft Edge WebView2 runtime, which
Windows 11 already has. (The EXE isn't code-signed, so Windows SmartScreen may ask you to
confirm with **More info → Run anyway** the first time.)

Your Gemini key and your Google/ChatGPT/Claude sign-ins stay on your own PC (see
[Your data](#your-data)); nothing is sent to the author.

## Link your Google Gemini account (first run, about a minute)

Gemini is what writes your super prompts.

1. Click **Open Google AI Studio**. A Google window opens inside the app; sign in with your Google account.
2. Click **Create API key**, then **Copy**.
3. The app notices the key on your clipboard, checks it with Google and links it. Done.

Or paste the key into the box yourself. You can also use **Use my browser instead** if you'd rather
create the key in Chrome/Edge.

Why a key? Google doesn't let other apps sign in to the Gemini chat app directly. The official
way to connect an app to your Google account's Gemini is an API key from Google AI Studio.
Creating one is free, and usage counts against your account's Gemini API limits (the free tier,
or billing if you've turned it on in AI Studio).

The key is stored in **Windows Credential Manager** (entry `SuperPromptCreator/gemini-api-key`)
and is only ever sent to Google, in a request header.

## Sign in to ChatGPT and Claude (optional)

The side bar has **Gemini**, **ChatGPT** and **Claude** buttons. Each opens that site in a window
inside the app. Sign in there once, with Google, Microsoft, Apple or email, as you normally would;
the app remembers it. **Settings → AI accounts** shows where you're signed in, with **Sign in /
Open** and **Sign out** for each.

Then **Send to ChatGPT** / **Send to Claude** / **Send to Gemini** opens a new chat there, types your
prompt in and sends it. The button follows the "Prompt for" choice; the small ▾ next to it lets you
pick another one (or copy the prompt and open the site in your normal browser instead).
The first time you send to a site you haven't signed in to, the app opens it and asks you to
sign in first, so nothing goes into a signed-out chat.

These are your normal ChatGPT and Claude accounts (free or paid). No API keys are needed for them.

## Using it

- **From an idea**: describe what you want, choose who it's for (Gemini, ChatGPT, Claude, any AI,
  an image generator or a video generator), the type and the level of detail, then
  **Create super prompt** (Ctrl+Enter).
- **Ask me quick questions first**: Gemini asks 2–4 tap-to-answer questions before writing
  the prompt. Skip any you like.
- **Improve a prompt**: paste a prompt you already use; you get a stronger version plus a list of what changed.
- **Fill in the blanks**: things only you know show up as `{{BLANKS}}` with input boxes.
  Copy, Test run and Send use your answers.
- **Refine**: one-click tweaks (Shorter, More detail, Make it a Gem…) or type your own. Every
  version is kept (v1, v2, …).
- **Test run**: runs the prompt on your Gemini key and shows the answer (or a test image for
  image prompts, if your key has an image model).
- **Send to Gemini / ChatGPT / Claude**: see above. You can switch to "just type it in" (you press
  Enter yourself) in Settings. The prompt is also put on your clipboard, so if a site changes its
  page and typing fails, Ctrl+V works.
- **Make a Gem**: copies the prompt and opens Gemini's Gem creator.
- **Library**: every prompt is saved automatically; search, star, copy, delete.

Shortcuts: Ctrl+Enter create/refine · Esc stop · Ctrl+Shift+C copy · Ctrl+1 / Ctrl+2 / Ctrl+, pages.

## Your data

- Prompts and settings: `%APPDATA%\com.superprompt.creator\` (`library.json`, `settings.json`).
- The in-app sign-ins (Google, ChatGPT, Claude): `%LOCALAPPDATA%\com.superprompt.creator\EBWebView\`.
  **Settings → AI accounts → Sign out** removes one site's sign-in.
- **Settings → Unlink** removes the Gemini API key from Credential Manager.

The app talks to `generativelanguage.googleapis.com` (with your key) and shows the Gemini, ChatGPT
and Claude websites in its own windows. There is no other server. Those web pages can't read your
key, your library or your clipboard: every app command checks that it comes from the app's own window.

## Troubleshooting

| Message | What to do |
|---|---|
| "this API key isn't valid" | Copy the whole key again from AI Studio and link it. |
| "rate limit … was hit" | Wait the time shown, or pick a Flash model in Settings. |
| "used today's Gemini requests" | Daily free limit for that model; pick another model or try tomorrow. |
| "needs billing turned on … in your country" | In some countries Google only serves the API with billing on. Set it up on the key's project in AI Studio. |
| "isn't available in your country or region" | The Gemini API isn't offered where you are. |
| Send didn't type anything | Press Ctrl+V in the site's message box (the prompt is on your clipboard). |
| "Continue with Google" won't sign in to ChatGPT/Claude in the app | Use email sign-in in that window, or the ▾ menu's "Copy & open in my browser". |

## Build from source

Requirements: Rust (stable, MSVC) and the WebView2 runtime. No Node or Tauri CLI needed.

```
cd src-tauri
cargo build --release      # -> src-tauri\target\release\SuperPromptCreator.exe
cargo test                 # Rust unit tests (streaming parser, error messages, URL/cookie rules…)
```

Tests that don't need a real key:

- `python tests/serve_ui.py --port 8774`, then open `http://localhost:8774/?linked`: the UI with a
  fake backend (`tests/mock-tauri.js`; add `&signedin=chatgpt,claude` to fake site sign-ins).
- `node tests/exe_smoke.mjs`: starts the real EXE off-screen in `--test` mode against a fake Gemini
  API (`tests/mock_gemini_server.py`) and checks linking, streaming, Stop, errors, the UI flow,
  sign-in detection/sign-out, and that Gemini/ChatGPT pages can't call the app. It removes its test
  profile and test key afterwards.
- `node tests/chat_inject_probe.mjs chatgpt`: opens the real site signed out (fresh test profile)
  and checks that the prompt gets typed into its message box. Nothing is sent.

Layout: `src-tauri/src` (Rust: `gemini.rs` API client, `creds.rs` Credential Manager,
`sites.rs` in-app site windows, `inject_chat.js` types prompts into the sites), `ui/` (the
interface; `prompts.js` holds the prompt-engineering instructions).
