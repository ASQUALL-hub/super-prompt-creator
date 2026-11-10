#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod creds;
mod gemini;
mod sites;
mod store;
mod util;

use gemini::{ApiError, ModelInfo, StreamEvent};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder, Wry};
use tokio::sync::Notify;

const DEFAULT_WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub struct AppState {
    pub client: reqwest::Client,
    pub api_base: String,
    pub cred_target: String,
    pub data_dir: PathBuf,
    pub webview_dir: Option<PathBuf>,
    pub browser_args: Option<String>,
    pub test: bool,
    key: Mutex<Option<String>>,
    streams: Mutex<HashMap<u32, Arc<Notify>>>,
    key_watch: Mutex<Option<Arc<AtomicBool>>>,
    pub pending: Mutex<HashMap<&'static str, sites::Pending>>,
    shown: AtomicBool,
}

impl AppState {
    fn api_key(&self) -> Option<String> {
        let mut k = self.key.lock().unwrap();
        if k.is_none() {
            *k = creds::load(&self.cred_target);
        }
        k.clone()
    }
}

/// Every window must use the same WebView2 environment (data folder + browser
/// arguments), or WebView2 refuses to create the second one.
pub fn apply_webview_env<'a>(
    mut b: WebviewWindowBuilder<'a, Wry, AppHandle>,
    st: &AppState,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    if let Some(dir) = &st.webview_dir {
        b = b.data_directory(dir.clone());
    }
    if let Some(args) = &st.browser_args {
        b = b.additional_browser_args(args);
    }
    if st.test {
        // Test runs must never pop over (or take focus from) whatever the user is doing.
        b = b.position(-30000.0, -30000.0).focused(false).skip_taskbar(true);
    }
    b
}

fn show_main(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.test || st.shown.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_main(app: &AppHandle) -> tauri::Result<()> {
    let st = app.state::<AppState>();
    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Super Prompt Creator")
        .inner_size(1300.0, 860.0)
        .min_inner_size(1000.0, 660.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(10, 12, 18, 255))
        .on_navigation(|u| {
            if util::is_app_url(u) {
                return true;
            }
            if matches!(u.scheme(), "http" | "https") {
                let _ = util::open_in_browser(u.as_str());
            }
            false
        })
        .on_new_window(|u, _features| {
            if matches!(u.scheme(), "http" | "https") {
                let _ = util::open_in_browser(u.as_str());
            }
            NewWindowResponse::Deny
        });
    b = if st.test { b.visible(true) } else { b.visible(false).center() };
    b = apply_webview_env(b, &st);
    b.build()?;
    Ok(())
}

fn forbidden(e: String) -> ApiError {
    ApiError::new("forbidden", e)
}

fn not_linked() -> ApiError {
    ApiError::new("auth", "Link your Google Gemini account first.")
}

fn set_clipboard(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.to_string()))
        .map_err(|e| format!("Couldn't use the clipboard: {e}"))
}

fn clipboard_google_key() -> Option<String> {
    let mut cb = arboard::Clipboard::new().ok()?;
    let text = cb.get_text().ok()?;
    let t = text.trim();
    // Only ever look for an API key; nothing else on the clipboard is kept or sent anywhere.
    if gemini::looks_like_google_key(t) {
        Some(t.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
async fn app_ready(webview: Webview, app: AppHandle) -> Result<(), String> {
    util::guard(&webview)?;
    show_main(&app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    test: bool,
    data_dir: String,
    custom_api: bool,
}

#[tauri::command]
async fn app_info(webview: Webview, state: State<'_, AppState>) -> Result<AppInfo, String> {
    util::guard(&webview)?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        test: state.test,
        data_dir: state.data_dir.display().to_string(),
        custom_api: state.api_base != gemini::DEFAULT_API_BASE,
    })
}

#[derive(Serialize)]
struct Status {
    connected: bool,
    masked: String,
}

#[tauri::command]
async fn gemini_status(webview: Webview, state: State<'_, AppState>) -> Result<Status, String> {
    util::guard(&webview)?;
    Ok(match state.api_key() {
        Some(k) => Status { connected: true, masked: gemini::mask_key(&k) },
        None => Status { connected: false, masked: String::new() },
    })
}

#[derive(Serialize, Clone)]
struct Linked {
    masked: String,
    models: Vec<ModelInfo>,
}

#[tauri::command]
async fn gemini_connect(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Linked, ApiError> {
    util::guard(&webview).map_err(forbidden)?;
    let key = gemini::normalize_key(&key).ok_or_else(|| {
        ApiError::new(
            "auth",
            "That doesn't look like an API key. In Google AI Studio, click Copy next to your key and paste it here.",
        )
    })?;
    let models = gemini::list_models(&state.client, &state.api_base, &key).await?;
    creds::save(&state.cred_target, &key).map_err(|e| ApiError::new("other", e))?;
    *state.key.lock().unwrap() = Some(key.clone());
    if let Some(flag) = state.key_watch.lock().unwrap().take() {
        flag.store(true, Ordering::SeqCst);
    }
    sites::close(&app, "connect");
    Ok(Linked { masked: gemini::mask_key(&key), models })
}

#[tauri::command]
async fn gemini_disconnect(webview: Webview, state: State<'_, AppState>) -> Result<(), String> {
    util::guard(&webview)?;
    creds::delete(&state.cred_target);
    *state.key.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn gemini_models(webview: Webview, state: State<'_, AppState>) -> Result<Vec<ModelInfo>, ApiError> {
    util::guard(&webview).map_err(forbidden)?;
    let key = state.api_key().ok_or_else(not_linked)?;
    gemini::list_models(&state.client, &state.api_base, &key).await
}

#[tauri::command]
async fn gemini_generate(
    webview: Webview,
    state: State<'_, AppState>,
    model: String,
    body: Value,
) -> Result<Value, ApiError> {
    util::guard(&webview).map_err(forbidden)?;
    let key = state.api_key().ok_or_else(not_linked)?;
    gemini::generate(&state.client, &state.api_base, &key, &model, &body).await
}

/// Streams one generation. All results (text, images, done, error) arrive on
/// `on_event`; the command itself only fails if the caller isn't allowed.
#[tauri::command]
async fn gemini_stream(
    webview: Webview,
    state: State<'_, AppState>,
    request_id: u32,
    model: String,
    body: Value,
    on_event: Channel<StreamEvent>,
) -> Result<(), ApiError> {
    util::guard(&webview).map_err(forbidden)?;
    let emit = |ev: StreamEvent| {
        let _ = on_event.send(ev);
    };
    let Some(key) = state.api_key() else {
        let e = not_linked();
        emit(StreamEvent::Error { kind: e.kind, message: e.message });
        return Ok(());
    };
    let cancel = Arc::new(Notify::new());
    state.streams.lock().unwrap().insert(request_id, cancel.clone());
    let result = gemini::stream(&state.client, &state.api_base, &key, &model, &body, cancel, &emit).await;
    state.streams.lock().unwrap().remove(&request_id);
    match result {
        Ok(acc) => emit(acc.done_event()),
        Err(e) => emit(StreamEvent::Error { kind: e.kind, message: e.message }),
    }
    Ok(())
}

#[tauri::command]
async fn gemini_cancel(webview: Webview, state: State<'_, AppState>, request_id: u32) -> Result<(), String> {
    util::guard(&webview)?;
    if let Some(n) = state.streams.lock().unwrap().get(&request_id) {
        n.notify_one();
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum KeyEvent {
    Found,
    Linked { masked: String, models: Vec<ModelInfo> },
    Invalid { message: String },
    Stopped,
}

/// While the "Link your account" screen is open, watch the clipboard for a
/// Google API key (the user clicks Copy in AI Studio) and link it automatically.
#[tauri::command]
async fn key_watch_start(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<KeyEvent>,
) -> Result<(), String> {
    util::guard(&webview)?;
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.key_watch.lock().unwrap().replace(stop.clone()) {
        old.store(true, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        let mut last_tried = String::new();
        loop {
            if stop.load(Ordering::SeqCst) || Instant::now() > deadline {
                let _ = on_event.send(KeyEvent::Stopped);
                break;
            }
            let found = tauri::async_runtime::spawn_blocking(clipboard_google_key).await.ok().flatten();
            if let Some(k) = found.filter(|k| *k != last_tried) {
                last_tried = k.clone();
                let _ = on_event.send(KeyEvent::Found);
                match gemini::list_models(&st.client, &st.api_base, &k).await {
                    Ok(models) if !stop.load(Ordering::SeqCst) => match creds::save(&st.cred_target, &k) {
                        Ok(()) => {
                            *st.key.lock().unwrap() = Some(k.clone());
                            sites::close(&app, "connect");
                            let _ = on_event.send(KeyEvent::Linked { masked: gemini::mask_key(&k), models });
                            break;
                        }
                        Err(e) => {
                            let _ = on_event.send(KeyEvent::Invalid { message: e });
                        }
                    },
                    Ok(_) => break,
                    Err(e) => {
                        let _ = on_event.send(KeyEvent::Invalid { message: e.message });
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        let mut slot = st.key_watch.lock().unwrap();
        if slot.as_ref().map(|s| Arc::ptr_eq(s, &stop)).unwrap_or(false) {
            *slot = None;
        }
    });
    Ok(())
}

#[tauri::command]
async fn key_watch_stop(webview: Webview, state: State<'_, AppState>) -> Result<(), String> {
    util::guard(&webview)?;
    if let Some(flag) = state.key_watch.lock().unwrap().take() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn store_read(webview: Webview, state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    util::guard(&webview)?;
    store::read(&state.data_dir, &name)
}

#[tauri::command]
async fn store_write(webview: Webview, state: State<'_, AppState>, name: String, data: String) -> Result<(), String> {
    util::guard(&webview)?;
    store::write(&state.data_dir, &name, &data)
}

#[tauri::command]
async fn clipboard_write(webview: Webview, text: String) -> Result<(), String> {
    util::guard(&webview)?;
    tauri::async_runtime::spawn_blocking(move || set_clipboard(&text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_url(webview: Webview, url: String) -> Result<(), String> {
    util::guard(&webview)?;
    util::open_in_browser(&url)
}

#[tauri::command]
async fn open_data_dir(webview: Webview, state: State<'_, AppState>) -> Result<(), String> {
    util::guard(&webview)?;
    std::fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    util::shell_open(&state.data_dir.display().to_string())
}

#[tauri::command]
async fn export_text(
    webview: Webview,
    app: AppHandle,
    suggested_name: String,
    content: String,
    ext: String,
) -> Result<Option<String>, String> {
    util::guard(&webview)?;
    let (ext, label) = match ext.as_str() {
        "json" => ("json", "JSON"),
        "txt" => ("txt", "Text"),
        _ => ("md", "Markdown"),
    };
    let file_name = util::safe_file_name(&suggested_name, ext);
    let docs = app.path().document_dir().ok();
    let parent = app.get_webview_window("main");
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = rfd::FileDialog::new().set_file_name(&file_name).add_filter(label, &[ext]);
        if let Some(dir) = docs {
            d = d.set_directory(dir);
        }
        if let Some(w) = &parent {
            d = d.set_parent(w);
        }
        d.save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        Some(path) => {
            std::fs::write(&path, content.as_bytes()).map_err(|e| format!("Couldn't save the file: {e}"))?;
            Ok(Some(path.display().to_string()))
        }
        None => Ok(None),
    }
}

fn parse_site(site: &str) -> Result<sites::Site, String> {
    sites::Site::parse(site).ok_or_else(|| format!("Unknown site '{site}'."))
}

/// Open one of the in-app windows: AI Studio (API key), the Gem creator, or a chat site.
#[tauri::command]
async fn site_open(webview: Webview, app: AppHandle, target: String) -> Result<(), String> {
    util::guard(&webview)?;
    match target.as_str() {
        "aistudio" => sites::show(&app, "connect", sites::AISTUDIO_KEYS, true),
        "gems" => sites::show(&app, "gemini", sites::GEMS_NEW, true),
        other => {
            let site = parse_site(other)?;
            sites::show(&app, site.key(), site.new_chat_url(), false)
        }
    }
}

#[tauri::command]
async fn site_close(webview: Webview, app: AppHandle, target: String) -> Result<(), String> {
    util::guard(&webview)?;
    if target == "connect" || sites::Site::parse(&target).is_some() {
        sites::close(&app, &target);
    }
    Ok(())
}

/// Type the prompt into a fresh chat on Gemini, ChatGPT or Claude (in the app's
/// own window, signed in with the user's account) and optionally press Send.
#[tauri::command]
async fn chat_send(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    site: String,
    text: String,
    auto_send: bool,
) -> Result<(), String> {
    util::guard(&webview)?;
    let site = parse_site(&site)?;
    if text.trim().is_empty() {
        return Err("There's nothing to send yet.".into());
    }
    if text.len() > 300_000 {
        return Err("That prompt is too long to send in one message.".into());
    }
    // Also on the clipboard, so Ctrl+V works if a site changes its page layout.
    // (Not in --test runs, which must leave the user's clipboard alone.)
    if !state.test {
        let clip = text.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || set_clipboard(&clip)).await;
    }
    sites::send(&app, site, text, auto_send)
}

#[derive(Serialize)]
struct SitesStatus {
    gemini: bool,
    chatgpt: bool,
    claude: bool,
}

/// Whether the app's own browser profile is signed in to each site.
#[tauri::command]
async fn sites_status(webview: Webview) -> Result<SitesStatus, String> {
    util::guard(&webview)?;
    let [gemini, chatgpt, claude] = sites::signed_in(&webview)?;
    Ok(SitesStatus { gemini, chatgpt, claude })
}

/// Sign out of one site inside the app (its window closes and its cookies are deleted).
#[tauri::command]
async fn site_signout(webview: Webview, app: AppHandle, site: String) -> Result<usize, String> {
    util::guard(&webview)?;
    let site = parse_site(&site)?;
    sites::sign_out(&app, &webview, site)
}

// -------------------------------------------------------------------- main

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let test = args.iter().any(|a| a == "--test");
    let debug_port = args
        .windows(2)
        .find(|w| w[0] == "--remote-debug-port")
        .and_then(|w| w[1].parse::<u16>().ok());

    let mut builder = tauri::Builder::default();
    if !test {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)));
    }

    builder
        .setup(move |app| {
            let handle = app.handle().clone();
            let base_dir = app.path().app_data_dir()?;
            let data_dir = if test { base_dir.join("test-profile") } else { base_dir };
            std::fs::create_dir_all(&data_dir)?;
            let webview_dir = if test { Some(app.path().app_local_data_dir()?.join("EBWebView-test")) } else { None };
            let browser_args = if test {
                let mut a = format!("{DEFAULT_WEBVIEW_ARGS},CalculateNativeWinOcclusion --mute-audio");
                if let Some(p) = debug_port {
                    a.push_str(&format!(" --remote-debugging-port={p}"));
                }
                Some(a)
            } else {
                None
            };
            // Tests may point the app at a local mock of the Gemini API (loopback only).
            let api_base = std::env::var("SPC_API_BASE")
                .ok()
                .filter(|_| test)
                .filter(|b| b.starts_with("http://127.0.0.1:") || b.starts_with("http://localhost:"))
                .map(|b| b.trim_end_matches('/').to_string())
                .unwrap_or_else(|| gemini::DEFAULT_API_BASE.to_string());
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .user_agent(concat!("SuperPromptCreator/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                client,
                api_base,
                cred_target: if test { "SuperPromptCreator-test/gemini-api-key" } else { "SuperPromptCreator/gemini-api-key" }
                    .into(),
                data_dir,
                webview_dir,
                browser_args,
                test,
                key: Mutex::new(None),
                streams: Mutex::new(HashMap::new()),
                key_watch: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                shown: AtomicBool::new(false),
            });
            build_main(&handle)?;
            if !test {
                // Normally the page asks to be shown once it has drawn; this is the safety net.
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    let h2 = h.clone();
                    let _ = h.run_on_main_thread(move || show_main(&h2));
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            app_info,
            gemini_status,
            gemini_connect,
            gemini_disconnect,
            gemini_models,
            gemini_generate,
            gemini_stream,
            gemini_cancel,
            key_watch_start,
            key_watch_stop,
            store_read,
            store_write,
            clipboard_write,
            open_url,
            open_data_dir,
            export_text,
            site_open,
            site_close,
            chat_send,
            sites_status,
            site_signout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Super Prompt Creator");
}
