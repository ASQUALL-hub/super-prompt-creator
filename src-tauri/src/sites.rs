//! In-app windows for the AI sites: Google AI Studio (to create the API key),
//! Gemini, ChatGPT and Claude. They share one WebView2 profile, so each sign-in
//! is remembered. Pages in these windows can't call the app (see util::guard).
//!
//! "Send to …" queues the prompt, opens a new chat, and once the chat page has
//! loaded types the prompt in (src/inject_chat.js). A queued prompt is retried
//! on reloads for two minutes (e.g. after a Cloudflare check), and the page
//! remembers in sessionStorage that it already got it, so it is never typed twice.

use crate::{util, AppState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

pub const AISTUDIO_KEYS: &str = "https://aistudio.google.com/apikey";
pub const GEMS_NEW: &str = "https://gemini.google.com/gems/create";
const INJECT_JS: &str = include_str!("inject_chat.js");
const PENDING_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Site {
    Gemini,
    ChatGpt,
    Claude,
}

pub const ALL: [Site; 3] = [Site::Gemini, Site::ChatGpt, Site::Claude];

impl Site {
    pub fn parse(s: &str) -> Option<Site> {
        match s {
            "gemini" => Some(Site::Gemini),
            "chatgpt" => Some(Site::ChatGpt),
            "claude" => Some(Site::Claude),
            _ => None,
        }
    }

    /// Also the window label.
    pub fn key(self) -> &'static str {
        match self {
            Site::Gemini => "gemini",
            Site::ChatGpt => "chatgpt",
            Site::Claude => "claude",
        }
    }

    pub fn new_chat_url(self) -> &'static str {
        match self {
            Site::Gemini => "https://gemini.google.com/app",
            Site::ChatGpt => "https://chatgpt.com/",
            Site::Claude => "https://claude.ai/new",
        }
    }

    /// A page with the prompt box (not a sign-in page), where a queued prompt may be typed.
    pub fn is_chat_page(self, url: &Url) -> bool {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        let path = url.path();
        match self {
            Site::Gemini => host == "gemini.google.com",
            Site::ChatGpt => (host == "chatgpt.com" || host == "chat.openai.com") && !path.starts_with("/auth"),
            Site::Claude => {
                host == "claude.ai"
                    && !["/login", "/logout", "/magic-link", "/onboarding", "/signup", "/invite"]
                        .iter()
                        .any(|p| path.starts_with(p))
            }
        }
    }

    /// Does a cookie with this domain belong to the site's sign-in?
    pub fn owns_cookie_domain(self, domain: &str) -> bool {
        let d = domain.trim_start_matches('.').to_ascii_lowercase();
        let under = |s: &str| d == s || d.ends_with(&format!(".{s}"));
        match self {
            Site::Gemini => is_google_host(&d),
            Site::ChatGpt => under("chatgpt.com") || under("openai.com"),
            Site::Claude => under("claude.ai") || under("anthropic.com"),
        }
    }

    /// A cookie that only exists while signed in.
    pub fn is_session_cookie(self, name: &str, domain: &str) -> bool {
        if !self.owns_cookie_domain(domain) {
            return false;
        }
        match self {
            Site::Gemini => {
                matches!(name, "SID" | "__Secure-1PSID" | "__Secure-3PSID")
                    && domain.trim_start_matches('.').to_ascii_lowercase().ends_with("google.com")
            }
            Site::ChatGpt => name.starts_with("__Secure-next-auth.session-token"),
            Site::Claude => name == "sessionKey",
        }
    }
}

pub struct Pending {
    pub text: String,
    pub auto_send: bool,
    pub nonce: String,
    pub created: Instant,
}

pub fn is_google_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    const SUFFIXES: [&str; 8] = [
        "google.com",
        "gstatic.com",
        "googleusercontent.com",
        "googleapis.com",
        "youtube.com",
        "ggpht.com",
        "ai.dev",
        "withgoogle.com",
    ];
    if SUFFIXES.iter().any(|s| h == *s || h.ends_with(&format!(".{s}"))) {
        return true;
    }
    // Country domains Google sign-in passes through: google.de, google.co.uk, google.com.au …
    let labels: Vec<&str> = h.split('.').collect();
    if let Some(i) = labels.iter().rposition(|l| *l == "google") {
        let rest = &labels[i + 1..];
        return match rest.len() {
            1 => rest[0].len() == 2,
            2 => matches!(rest[0], "co" | "com") && rest[1].len() == 2,
            _ => false,
        };
    }
    false
}

/// Sign-in providers whose pop-ups ("Continue with Google/Apple/Microsoft") must
/// stay inside the app so the login lands in the app's own profile.
fn is_auth_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let under = |s: &str| h == s || h.ends_with(&format!(".{s}"));
    is_google_host(&h)
        || ["apple.com", "microsoftonline.com", "live.com", "microsoft.com", "openai.com", "chatgpt.com", "claude.ai", "anthropic.com", "okta.com", "auth0.com"]
            .iter()
            .any(|s| under(s))
}

/// The Google windows (AI Studio, Gemini) only ever show Google pages.
pub fn allowed_in_google_window(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.host_str().map(is_google_host).unwrap_or(false),
        "about" | "blob" => true,
        _ => false,
    }
}

fn google_only(label: &str) -> bool {
    matches!(label, "connect" | "gemini")
}

fn title_for(label: &str) -> &'static str {
    match label {
        "connect" => "Link your Google account — Super Prompt Creator",
        "gemini" => "Gemini — Super Prompt Creator",
        "chatgpt" => "ChatGPT — Super Prompt Creator",
        "claude" => "Claude — Super Prompt Creator",
        _ => "Super Prompt Creator",
    }
}

pub fn inject_script(site: Site, text: &str, auto_send: bool, nonce: &str) -> String {
    let js = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    INJECT_JS
        .replacen("__SPC_SITE__", &js(site.key()), 1)
        .replacen("__SPC_TEXT__", &js(text), 1)
        .replacen("__SPC_AUTO__", if auto_send { "true" } else { "false" }, 1)
        .replacen("__SPC_NONCE__", &js(nonce), 1)
}

fn deliver(win: &WebviewWindow, site: Site) {
    let st = win.app_handle().state::<AppState>();
    let script = {
        let mut pending = st.pending.lock().unwrap();
        match pending.get(site.key()) {
            Some(p) if p.created.elapsed() <= PENDING_TTL => Some(inject_script(site, &p.text, p.auto_send, &p.nonce)),
            Some(_) => {
                pending.remove(site.key());
                None
            }
            None => None,
        }
    };
    if let Some(js) = script {
        let _ = win.eval(js);
    }
}

fn build(app: &AppHandle, label: &str, url: Url) -> Result<WebviewWindow, String> {
    let st = app.state::<AppState>();
    let strict = google_only(label);
    let (w, h) = if label == "connect" { (1080.0, 820.0) } else { (1040.0, 900.0) };
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title_for(label))
        .inner_size(w, h)
        .min_inner_size(520.0, 560.0)
        .theme(Some(tauri::Theme::Dark))
        .on_navigation(move |u| {
            let ok = if strict { allowed_in_google_window(u) } else { matches!(u.scheme(), "https" | "about" | "blob") };
            if ok {
                return true;
            }
            if matches!(u.scheme(), "http" | "https") {
                let _ = util::open_in_browser(u.as_str());
            }
            false
        })
        .on_new_window(move |u, _features| {
            if !strict && (u.scheme() == "about" || u.host_str().map(is_auth_host).unwrap_or(false)) {
                return NewWindowResponse::Allow;
            }
            if matches!(u.scheme(), "http" | "https") {
                let _ = util::open_in_browser(u.as_str());
            }
            NewWindowResponse::Deny
        });
    if let Some(site) = Site::parse(label) {
        b = b.on_page_load(move |win, payload| {
            if payload.event() == PageLoadEvent::Finished && site.is_chat_page(payload.url()) {
                deliver(&win, site);
            }
        });
    }
    b = crate::apply_webview_env(b, &st);
    if !st.test {
        b = b.center();
    }
    b.build().map_err(|e| format!("Couldn't open the window: {e}"))
}

/// Open (or bring back) a site window. `navigate` reloads it at `url` when it
/// already exists (e.g. a fresh chat for every prompt sent).
pub fn show(app: &AppHandle, label: &str, url: &str, navigate: bool) -> Result<(), String> {
    let url: Url = url.parse().map_err(|_| "Bad address".to_string())?;
    let test = app.state::<AppState>().test;
    if let Some(w) = app.get_webview_window(label) {
        if navigate {
            w.navigate(url).map_err(|e| e.to_string())?;
        }
        if !test {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    build(app, label, url).map(|_| ())
}

pub fn close(app: &AppHandle<Wry>, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
}

fn new_nonce() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{t:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Queue `text` for `site` and open a fresh chat there; the page-load hook types it in.
pub fn send(app: &AppHandle, site: Site, text: String, auto_send: bool) -> Result<(), String> {
    let st = app.state::<AppState>();
    st.pending.lock().unwrap().insert(
        site.key(),
        Pending { text, auto_send, nonce: new_nonce(), created: Instant::now() },
    );
    show(app, site.key(), site.new_chat_url(), true)
}

/// Which sites have a sign-in cookie in the app's profile (names only, values never leave Rust).
pub fn signed_in<R: Runtime>(webview: &Webview<R>) -> Result<[bool; 3], String> {
    let cookies = webview.cookies().map_err(|e| e.to_string())?;
    let mut out = [false; 3];
    for c in &cookies {
        let domain = c.domain().unwrap_or("");
        for (i, site) in ALL.iter().enumerate() {
            if site.is_session_cookie(c.name(), domain) {
                out[i] = true;
            }
        }
    }
    Ok(out)
}

/// Sign out of one site inside the app: close its window and delete its cookies.
pub fn sign_out<R: Runtime>(app: &AppHandle, webview: &Webview<R>, site: Site) -> Result<usize, String> {
    close(app, site.key());
    if site == Site::Gemini {
        close(app, "connect");
    }
    let cookies = webview.cookies().map_err(|e| e.to_string())?;
    let mut n = 0;
    for c in cookies {
        if site.owns_cookie_domain(c.domain().unwrap_or("")) {
            webview.delete_cookie(c).map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_hosts() {
        for h in ["gemini.google.com", "accounts.google.com", "aistudio.google.com", "accounts.google.de", "google.co.uk", "www.google.com.au", "ssl.gstatic.com", "lh3.googleusercontent.com", "accounts.youtube.com", "ai.dev"] {
            assert!(is_google_host(h), "{h}");
        }
        for h in ["evil.com", "google.com.evil.com", "notgoogle.com", "google.evil", "google.example.org", "gemini-google.com"] {
            assert!(!is_google_host(h), "{h}");
        }
        assert!(!allowed_in_google_window(&Url::parse("http://gemini.google.com/").unwrap()));
        assert!(!allowed_in_google_window(&Url::parse("file:///C:/Windows").unwrap()));
    }

    #[test]
    fn chat_pages_skip_sign_in_pages() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(Site::ChatGpt.is_chat_page(&u("https://chatgpt.com/")));
        assert!(!Site::ChatGpt.is_chat_page(&u("https://chatgpt.com/auth/login")));
        assert!(!Site::ChatGpt.is_chat_page(&u("https://auth.openai.com/log-in")));
        assert!(Site::Claude.is_chat_page(&u("https://claude.ai/new")));
        assert!(!Site::Claude.is_chat_page(&u("https://claude.ai/login?returnTo=%2Fnew")));
        assert!(Site::Gemini.is_chat_page(&u("https://gemini.google.com/app")));
        assert!(!Site::Gemini.is_chat_page(&u("https://accounts.google.com/v3/signin")));
    }

    #[test]
    fn session_cookies_and_domains() {
        assert!(Site::ChatGpt.is_session_cookie("__Secure-next-auth.session-token", ".chatgpt.com"));
        assert!(Site::ChatGpt.is_session_cookie("__Secure-next-auth.session-token.0", "chatgpt.com"));
        assert!(!Site::ChatGpt.is_session_cookie("__Secure-next-auth.session-token", ".evil.com"));
        assert!(Site::Claude.is_session_cookie("sessionKey", ".claude.ai"));
        assert!(!Site::Claude.is_session_cookie("sessionKey", "notclaude.ai"));
        assert!(Site::Gemini.is_session_cookie("SID", ".google.com"));
        assert!(!Site::Gemini.is_session_cookie("SID", ".youtube.com"));
        assert!(Site::ChatGpt.owns_cookie_domain("auth.openai.com"));
        assert!(!Site::ChatGpt.owns_cookie_domain("claude.ai"));
        assert!(Site::Gemini.owns_cookie_domain(".youtube.com"));
        assert!(is_auth_host("accounts.google.com") && is_auth_host("appleid.apple.com") && is_auth_host("login.microsoftonline.com"));
        assert!(!is_auth_host("example.com"));
    }

    #[test]
    fn inject_escapes_text() {
        let js = inject_script(Site::Claude, "line1\n\"quoted\" </script> ${x} `tick`", true, "abc-1");
        assert!(js.contains(r#"const TEXT = "line1\n\"quoted\" </script> ${x} `tick`";"#), "{js}");
        assert!(js.contains(r#"const SITE = "claude";"#));
        assert!(js.contains(r#"const NONCE = "abc-1";"#));
        assert!(js.contains("const AUTO_SEND = true;"));
        assert!(!js.contains("__SPC_"));
    }
}
