use tauri::{Runtime, Url, Webview};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Open a URL or folder with the user's default handler (browser / Explorer).
pub fn shell_open(target: &str) -> Result<(), String> {
    let op = wide("open");
    let file = wide(target);
    // SAFETY: NUL-terminated wide strings that live for the duration of the call.
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open it (code {}).", r as isize))
    }
}

/// Only plain web links go to the browser; never file:, javascript:, etc.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "That isn't a valid link.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web links can be opened.".into());
    }
    shell_open(parsed.as_str())
}

/// The app's own bundled pages (Tauri serves them from tauri.localhost).
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Every command calls this first: only the app's own main window may use
/// them. Google pages shown in the other windows are refused (Tauri does not
/// check app commands against capabilities by itself).
pub fn guard<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Not allowed from this window.".into());
    }
    match webview.url() {
        Ok(u) if is_app_url(&u) => Ok(()),
        _ => Err("Not allowed from this page.".into()),
    }
}

pub fn safe_file_name(name: &str, ext: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')') { c } else { '-' })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_matches(|c: char| c == '-' || c == ' ' || c == '.');
    let mut s: String = s.chars().take(80).collect();
    if s.is_empty() {
        s = "super-prompt".into();
    }
    format!("{s}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_url_check() {
        assert!(is_app_url(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(is_app_url(&Url::parse("tauri://localhost/").unwrap()));
        assert!(!is_app_url(&Url::parse("https://gemini.google.com/app").unwrap()));
        assert!(!is_app_url(&Url::parse("http://tauri.localhost.evil.com/").unwrap()));
    }

    #[test]
    fn file_names() {
        assert_eq!(safe_file_name("My: great/prompt?", "md"), "My- great-prompt.md");
        assert_eq!(safe_file_name("   ", "md"), "super-prompt.md");
        assert_eq!(safe_file_name("..\\..\\x", "txt"), "x.txt");
    }
}
