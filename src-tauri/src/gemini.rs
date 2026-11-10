//! Google Gemini API client (generativelanguage.googleapis.com, v1beta).
//!
//! The API key never leaves Rust except in the `x-goog-api-key` header sent to
//! Google. Requests are built by the UI; this module only forwards them,
//! streams Server-Sent Events back, and turns Google's errors into plain words.

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

pub const DEFAULT_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// How long a stream may go silent (e.g. while a "thinking" model reasons)
/// before we give up.
const STREAM_IDLE: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApiError {
    /// auth | quota | model | network | blocked | server | region | other | forbidden
    pub kind: String,
    pub message: String,
}

impl ApiError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.to_string(), message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub input_token_limit: u64,
    pub output_token_limit: u64,
    pub thinking: bool,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Thought { text: String },
    Image { mime_type: String, data: String },
    Done {
        finish_reason: Option<String>,
        block_reason: Option<String>,
        model_version: Option<String>,
        usage: Option<Value>,
    },
    Error { kind: String, message: String },
}

/// Model ids look like `gemini-2.5-flash`; reject anything that could change the URL path.
pub fn clean_model(model: &str) -> Result<String, ApiError> {
    let m = model.trim().trim_start_matches("models/");
    if m.is_empty()
        || m.starts_with('.')
        || m.len() > 120
        || !m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
    {
        return Err(ApiError::new("model", "Pick a Gemini model in Settings first."));
    }
    Ok(m.to_string())
}

pub fn mask_key(key: &str) -> String {
    let k: Vec<char> = key.chars().collect();
    if k.len() <= 10 {
        return "••••".into();
    }
    let head: String = k[..4].iter().collect();
    let tail: String = k[k.len() - 4..].iter().collect();
    format!("{head}••••••••{tail}")
}

/// Accepts what people actually paste: stray spaces, quotes, `KEY=` prefixes.
pub fn normalize_key(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if let Some(i) = s.rfind('=') {
        if s[..i].chars().all(|c| c.is_ascii_uppercase() || c == '_') {
            s = &s[i + 1..];
        }
    }
    let s = s.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').trim();
    if s.len() < 20
        || s.len() > 200
        || !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(s.to_string())
}

/// A Google API key as AI Studio hands it out (AIza + 35 chars). Used to spot
/// the key on the clipboard, so it is deliberately strict.
pub fn looks_like_google_key(s: &str) -> bool {
    let s = s.trim();
    s.len() == 39
        && s.starts_with("AIza")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn net_err(e: reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::new("network", "Google took too long to answer. Check your connection and try again.")
    } else if e.is_connect() {
        ApiError::new(
            "network",
            "Can't reach Google's servers. Check your internet connection (or VPN / proxy).",
        )
    } else {
        // reqwest errors carry the URL, which never contains the key (it travels in a header).
        ApiError::new("network", format!("Network problem while talking to Google: {e}"))
    }
}

fn parse_retry_delay(details: &[Value]) -> Option<String> {
    details.iter().find_map(|d| {
        let t = d.get("@type")?.as_str()?;
        if t.ends_with("RetryInfo") {
            d.get("retryDelay")?.as_str().map(|s| s.to_string())
        } else {
            None
        }
    })
}

fn humanize_delay(d: &str) -> String {
    let secs: f64 = d.trim_end_matches('s').parse().unwrap_or(0.0);
    if secs <= 0.0 {
        "a minute".into()
    } else if secs < 90.0 {
        format!("{} seconds", secs.ceil() as u64)
    } else {
        format!("{} minutes", (secs / 60.0).ceil() as u64)
    }
}

/// Turn a non-200 reply from Google into something a person can act on.
pub fn map_http_error(status: u16, body: &str) -> ApiError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let err = &v["error"];
    let msg = err["message"].as_str().unwrap_or("").trim().to_string();
    let st = err["status"].as_str().unwrap_or("");
    let details: Vec<Value> = err["details"].as_array().cloned().unwrap_or_default();
    let reasons: Vec<String> = details
        .iter()
        .filter_map(|d| d.get("reason").and_then(|r| r.as_str()).map(|s| s.to_string()))
        .collect();
    let lower = msg.to_lowercase();
    let has_reason = |r: &str| reasons.iter().any(|x| x == r);

    if has_reason("API_KEY_INVALID")
        || lower.contains("api key not valid")
        || lower.contains("api key expired")
        || (status == 400 && lower.contains("api key"))
        || status == 401
    {
        return ApiError::new(
            "auth",
            "Google says this API key isn't valid. Copy the whole key from Google AI Studio and link it again.",
        );
    }
    if lower.contains("leaked") {
        return ApiError::new(
            "auth",
            "Google has blocked this API key because it was reported as leaked. Create a new key in Google AI Studio.",
        );
    }
    if status == 403 || st == "PERMISSION_DENIED" {
        if lower.contains("has not been used") || lower.contains("is disabled") || has_reason("SERVICE_DISABLED") {
            return ApiError::new(
                "auth",
                "The Gemini API isn't turned on for this key's Google Cloud project. Create the key in Google AI Studio instead.",
            );
        }
        return ApiError::new(
            "auth",
            "This key isn't allowed to use Gemini (403). Check the key's restrictions in Google AI Studio, or create a new key there.",
        );
    }
    if st == "FAILED_PRECONDITION" && lower.contains("billing") {
        return ApiError::new(
            "region",
            "Google needs billing turned on for your key before the Gemini API will answer in your country. In Google AI Studio, open your key's project and set up billing (you pay only for what you use), then try again.",
        );
    }
    if st == "FAILED_PRECONDITION" && (lower.contains("location") || lower.contains("region") || lower.contains("country")) {
        return ApiError::new("region", "The Gemini API isn't available in your country or region yet.");
    }
    if lower.contains("user location is not supported") {
        return ApiError::new("region", "The Gemini API isn't available in your country or region yet.");
    }
    if status == 429 || st == "RESOURCE_EXHAUSTED" {
        let per_day = lower.contains("per day")
            || details.iter().any(|d| d.to_string().to_lowercase().contains("perday"));
        if per_day {
            return ApiError::new(
                "quota",
                "You've used today's Gemini requests for this model on your key. Pick another model in Settings (Flash models allow more) or try again tomorrow.",
            );
        }
        let wait = parse_retry_delay(&details).map(|d| humanize_delay(&d)).unwrap_or_else(|| "a minute".into());
        return ApiError::new(
            "quota",
            format!("Gemini's rate limit for your key was hit. Wait about {wait} and try again, or switch to a Flash model."),
        );
    }
    if status == 404 || st == "NOT_FOUND" {
        return ApiError::new("model", "That Gemini model isn't available for your key any more. Pick another model in Settings.");
    }
    if status == 503 || st == "UNAVAILABLE" {
        return ApiError::new("server", "Gemini is overloaded right now. Try again in a moment, or switch to another model.");
    }
    if status == 504 || st == "DEADLINE_EXCEEDED" {
        return ApiError::new("server", "Gemini took too long to answer. Try again, or use a faster Flash model.");
    }
    if status >= 500 {
        return ApiError::new("server", "Gemini had an internal error. Try again in a moment.");
    }
    if status == 400 && !msg.is_empty() {
        return ApiError::new("other", format!("Gemini couldn't handle that request: {msg}"));
    }
    if msg.is_empty() {
        ApiError::new("other", format!("Gemini returned an unexpected error (HTTP {status})."))
    } else {
        ApiError::new("other", format!("Gemini returned an error (HTTP {status}): {msg}"))
    }
}

fn parse_model(m: &Value) -> ModelInfo {
    let id = m["name"].as_str().unwrap_or("").trim_start_matches("models/").to_string();
    ModelInfo {
        display_name: m["displayName"].as_str().unwrap_or(&id).to_string(),
        description: m["description"].as_str().unwrap_or("").to_string(),
        input_token_limit: m["inputTokenLimit"].as_u64().unwrap_or(0),
        output_token_limit: m["outputTokenLimit"].as_u64().unwrap_or(0),
        thinking: m["thinking"].as_bool().unwrap_or(false),
        methods: m["supportedGenerationMethods"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        id,
    }
}

pub async fn list_models(client: &reqwest::Client, base: &str, key: &str) -> Result<Vec<ModelInfo>, ApiError> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..6 {
        let mut url = reqwest::Url::parse(&format!("{base}/models"))
            .map_err(|e| ApiError::new("other", format!("Bad API address: {e}")))?;
        url.query_pairs_mut().append_pair("pageSize", "1000");
        if let Some(p) = &page {
            url.query_pairs_mut().append_pair("pageToken", p);
        }
        let resp = client
            .get(url)
            .header("x-goog-api-key", key)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(net_err)?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(net_err)?;
        if status != 200 {
            return Err(map_http_error(status, &text));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| ApiError::new("other", format!("Unexpected reply from Google: {e}")))?;
        if let Some(models) = v["models"].as_array() {
            out.extend(models.iter().map(parse_model).filter(|m| !m.id.is_empty()));
        }
        page = v["nextPageToken"].as_str().filter(|s| !s.is_empty()).map(String::from);
        if page.is_none() {
            break;
        }
    }
    Ok(out)
}

pub async fn generate(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    let model = clean_model(model)?;
    let resp = client
        .post(format!("{base}/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(body)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(net_err)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(net_err)?;
    if status != 200 {
        return Err(map_http_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| ApiError::new("other", format!("Unexpected reply from Google: {e}")))
}

/// Incremental Server-Sent Events parser (only `data:` fields matter for Gemini).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: String,
    has_data: bool,
}

impl SseParser {
    /// Feed raw bytes; returns the payloads of every event completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            // Lines are complete, so multi-byte UTF-8 sequences are never split here.
            let line = String::from_utf8_lossy(&line);
            self.take_line(&line, &mut out);
        }
        out
    }

    fn take_line(&mut self, line: &str, out: &mut Vec<String>) {
        if line.is_empty() {
            if self.has_data {
                out.push(std::mem::take(&mut self.data));
                self.has_data = false;
            }
            return;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            if self.has_data {
                self.data.push('\n');
            }
            self.data.push_str(rest);
            self.has_data = true;
        }
        // `event:`, `id:`, `retry:` and `:comments` are not used by Gemini.
    }

    /// End of stream: flush a final event that had no trailing blank line.
    pub fn finish(&mut self) -> Option<String> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            for line in rest.split('\n') {
                self.take_line(line.trim_end_matches('\r'), &mut out);
            }
        }
        if self.has_data {
            self.has_data = false;
            out.push(std::mem::take(&mut self.data));
        }
        out.into_iter().rev().find(|s| !s.is_empty())
    }
}

#[derive(Default, Debug)]
pub struct StreamAcc {
    pub finish_reason: Option<String>,
    pub block_reason: Option<String>,
    pub model_version: Option<String>,
    pub usage: Option<Value>,
    pub chars: usize,
}

impl StreamAcc {
    pub fn done_event(&self) -> StreamEvent {
        StreamEvent::Done {
            finish_reason: self.finish_reason.clone(),
            block_reason: self.block_reason.clone(),
            model_version: self.model_version.clone(),
            usage: self.usage.clone(),
        }
    }
}

/// Handle one SSE payload (a GenerateContentResponse JSON chunk).
pub fn handle_payload(payload: &str, acc: &mut StreamAcc, emit: &dyn Fn(StreamEvent)) -> Result<(), ApiError> {
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return Ok(());
    }
    let v: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return Ok(()), // ignore keep-alives / partial junk
    };
    if v.get("error").is_some() {
        let code = v["error"]["code"].as_u64().unwrap_or(500) as u16;
        return Err(map_http_error(code, payload));
    }
    if let Some(br) = v["promptFeedback"]["blockReason"].as_str() {
        acc.block_reason = Some(br.to_string());
    }
    if let Some(c) = v["candidates"].get(0) {
        if let Some(parts) = c["content"]["parts"].as_array() {
            for part in parts {
                let is_thought = part["thought"].as_bool().unwrap_or(false);
                if let Some(t) = part["text"].as_str() {
                    if t.is_empty() {
                        continue;
                    }
                    if is_thought {
                        emit(StreamEvent::Thought { text: t.to_string() });
                    } else {
                        acc.chars += t.len();
                        emit(StreamEvent::Delta { text: t.to_string() });
                    }
                } else if let Some(inline) = part.get("inlineData") {
                    if let (Some(mime), Some(data)) = (inline["mimeType"].as_str(), inline["data"].as_str()) {
                        if mime.starts_with("image/") && !is_thought {
                            emit(StreamEvent::Image { mime_type: mime.to_string(), data: data.to_string() });
                        }
                    }
                }
            }
        }
        if let Some(fr) = c["finishReason"].as_str() {
            acc.finish_reason = Some(fr.to_string());
        }
    }
    if let Some(u) = v.get("usageMetadata") {
        acc.usage = Some(u.clone());
    }
    if let Some(mv) = v["modelVersion"].as_str() {
        acc.model_version = Some(mv.to_string());
    }
    Ok(())
}

/// Stream a generation. Emits Delta/Thought/Image events as they arrive and
/// returns the final summary (or an error). `cancel` stops it early.
pub async fn stream(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    body: &Value,
    cancel: Arc<Notify>,
    emit: &(dyn Fn(StreamEvent) + Send + Sync),
) -> Result<StreamAcc, ApiError> {
    let model = clean_model(model)?;
    let mut acc = StreamAcc::default();
    let send = client
        .post(format!("{base}/models/{model}:streamGenerateContent?alt=sse"))
        .header("x-goog-api-key", key)
        .json(body)
        .send();
    let resp = tokio::select! {
        _ = cancel.notified() => {
            acc.finish_reason = Some("CANCELLED".into());
            return Ok(acc);
        }
        r = tokio::time::timeout(Duration::from_secs(90), send) => match r {
            Err(_) => return Err(ApiError::new("network", "Google took too long to start answering. Try again.")),
            Ok(r) => r.map_err(net_err)?,
        },
    };
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Err(map_http_error(status, &text));
    }
    let mut body_stream = resp.bytes_stream();
    let mut parser = SseParser::default();
    loop {
        let next = tokio::select! {
            _ = cancel.notified() => {
                acc.finish_reason = Some("CANCELLED".into());
                return Ok(acc);
            }
            n = tokio::time::timeout(STREAM_IDLE, body_stream.next()) => n,
        };
        match next {
            Err(_) => {
                return Err(ApiError::new("network", "Gemini stopped sending data for 3 minutes, so the request was stopped."))
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(net_err(e)),
            Ok(Some(Ok(bytes))) => {
                for payload in parser.push(&bytes) {
                    handle_payload(&payload, &mut acc, emit)?;
                }
            }
        }
    }
    if let Some(p) = parser.finish() {
        handle_payload(&p, &mut acc, emit)?;
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn sse_parses_split_chunks_and_crlf() {
        let mut p = SseParser::default();
        let mut got = Vec::new();
        got.extend(p.push(b"data: {\"a\":"));
        got.extend(p.push(b"1}\r\n\r\ndata: {\"b\":2}\r\n"));
        assert_eq!(got, vec!["{\"a\":1}".to_string()]);
        got.extend(p.push(b"\r\n"));
        assert_eq!(got, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert_eq!(p.finish(), None);
    }

    #[test]
    fn sse_keeps_utf8_split_across_chunks() {
        let s = "data: {\"t\":\"héllo ✨\"}\n\n".as_bytes();
        let mut p = SseParser::default();
        let mut got = Vec::new();
        for b in s {
            got.extend(p.push(&[*b]));
        }
        assert_eq!(got, vec!["{\"t\":\"héllo ✨\"}".to_string()]);
    }

    #[test]
    fn sse_flushes_last_event_without_blank_line() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: {\"x\":1}").is_empty());
        assert_eq!(p.finish().as_deref(), Some("{\"x\":1}"));
    }

    #[test]
    fn payload_emits_text_thought_image_and_finish() {
        let events = RefCell::new(Vec::new());
        let emit = |e: StreamEvent| events.borrow_mut().push(e);
        let mut acc = StreamAcc::default();
        let payload = r#"{"candidates":[{"content":{"role":"model","parts":[
            {"text":"thinking...","thought":true},{"text":"Hello"},
            {"inlineData":{"mimeType":"image/png","data":"AAAA"}}]},
            "finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":5},"modelVersion":"gemini-x"}"#;
        handle_payload(payload, &mut acc, &emit).unwrap();
        let ev = events.borrow();
        assert_eq!(ev.len(), 3);
        assert!(matches!(&ev[0], StreamEvent::Thought { text } if text == "thinking..."));
        assert!(matches!(&ev[1], StreamEvent::Delta { text } if text == "Hello"));
        assert!(matches!(&ev[2], StreamEvent::Image { mime_type, .. } if mime_type == "image/png"));
        assert_eq!(acc.finish_reason.as_deref(), Some("STOP"));
        assert_eq!(acc.model_version.as_deref(), Some("gemini-x"));
    }

    #[test]
    fn payload_error_object_becomes_error() {
        let emit = |_e: StreamEvent| {};
        let mut acc = StreamAcc::default();
        let r = handle_payload(r#"{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}"#, &mut acc, &emit);
        assert_eq!(r.unwrap_err().kind, "server");
    }

    #[test]
    fn maps_common_google_errors() {
        let bad_key = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}"#;
        assert_eq!(map_http_error(400, bad_key).kind, "auth");
        let rate = r#"{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}"#;
        let e = map_http_error(429, rate);
        assert_eq!(e.kind, "quota");
        assert!(e.message.contains("37 seconds"), "{}", e.message);
        let daily = r#"{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}"#;
        assert!(map_http_error(429, daily).message.contains("today"));
        let region = r#"{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}"#;
        assert_eq!(map_http_error(400, region).kind, "region");
        let billing = r#"{"error":{"code":400,"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}"#;
        let e = map_http_error(400, billing);
        assert!(e.kind == "region" && e.message.contains("billing"), "{e:?}");
        let quota_billing = r#"{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}"#;
        assert_eq!(map_http_error(429, quota_billing).kind, "quota");
        assert_eq!(map_http_error(503, "").kind, "server");
        assert_eq!(map_http_error(404, "{}").kind, "model");
        assert_eq!(map_http_error(403, r#"{"error":{"message":"Permission denied","status":"PERMISSION_DENIED"}}"#).kind, "auth");
    }

    #[test]
    fn key_helpers() {
        // 39 chars, fake; split so secret scanners don't mistake it for a real key
        let key = concat!("AI", "zaSyA1234567890abcdefghijklmnopqrstuv");
        assert_eq!(key.len(), 39);
        assert!(looks_like_google_key(key));
        assert!(!looks_like_google_key("hello world"));
        assert_eq!(normalize_key(&format!("  \"{key}\" ")).as_deref(), Some(key));
        assert_eq!(normalize_key(&format!("GEMINI_API_KEY={key}")).as_deref(), Some(key));
        assert_eq!(normalize_key("short"), None);
        assert_eq!(mask_key(key), "AIza••••••••stuv");
        assert!(clean_model("models/gemini-2.5-flash").is_ok());
        assert!(clean_model("../evil").is_err());
        assert!(clean_model("gemini?x=1").is_err());
    }
}
