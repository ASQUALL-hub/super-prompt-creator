"""A tiny stand-in for the Gemini REST API (v1beta), for testing the real EXE
without a Google key. Run: python tests/mock_gemini_server.py --port 8790
Then start the app with:  SPC_API_BASE=http://127.0.0.1:8790/v1beta  SuperPromptCreator.exe --test

Keys: anything starting with AIzaGOOD is accepted; AIzaBAD... gets Google's
"API key not valid" error. GET /__log returns what the app sent (keys masked)."""
import argparse
import http.server
import json
import time

GOOD_PREFIX = "AIzaGOOD"
LOG = []

MODELS = [
    ("gemini-2.5-pro", "Gemini 2.5 Pro"), ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-flash-latest", "Gemini Flash Latest"), ("gemini-2.5-flash-image", "Nano Banana"),
    ("text-embedding-004", "Text Embedding 004"),
]

PROMPT = """## Role
You are a patient Spanish tutor for busy adults.

## Task
Build a 12-week plan for a {{CURRENT_LEVEL}} learner — ¡vamos! ✨

## Output format
A table per phase.

---NOTES---
Title: Mock Spanish Plan
- Fill in {{CURRENT_LEVEL}} first.
"""


def bad_key_error():
    return 400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT",
                           "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def key_ok(self):
        key = self.headers.get("x-goog-api-key", "")
        return key.startswith(GOOD_PREFIX), key

    def log_req(self, body=None):
        key = self.headers.get("x-goog-api-key", "")
        LOG.append({"method": self.command, "path": self.path, "key": (key[:8] + "…") if key else "", "query_has_key": "key=" in self.path, "body": body})

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=UTF-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/__log"):
            return self.send_json(200, LOG)
        self.log_req()
        ok, _ = self.key_ok()
        if not ok:
            return self.send_json(*bad_key_error())
        if self.path.startswith("/v1beta/models"):
            return self.send_json(200, {"models": [{
                "name": f"models/{mid}", "displayName": name, "description": "mock",
                "inputTokenLimit": 1048576, "outputTokenLimit": 65536, "thinking": True,
                "supportedGenerationMethods": ["embedContent"] if "embedding" in mid else ["generateContent", "countTokens"],
            } for mid, name in MODELS]})
        self.send_json(404, {"error": {"code": 404, "message": "not found", "status": "NOT_FOUND"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.log_req(body)
        ok, _ = self.key_ok()
        if not ok:
            return self.send_json(*bad_key_error())
        text_in = json.dumps(body)
        if ":generateContent" in self.path:
            if body.get("generationConfig", {}).get("responseMimeType") == "application/json":
                qs = {"questions": [{"question": "What is your current level?", "options": ["Beginner", "Some", "Fluent"]},
                                    {"question": "How long per day?", "options": ["15 min", "30 min", "1 hour"]}]}
                return self.send_json(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(qs)}], "role": "model"}, "finishReason": "STOP"}]})
            return self.send_json(200, {"candidates": [{"content": {"parts": [{"text": "plain answer"}], "role": "model"}, "finishReason": "STOP"}]})
        if ":streamGenerateContent" in self.path:
            if "#rate" in text_in:
                return self.send_json(429, {"error": {"code": 429, "message": "Resource has been exhausted (e.g. check quota).", "status": "RESOURCE_EXHAUSTED",
                                                      "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "21s"}]}})
            slow = "#slow" in text_in
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def chunk(b):
                self.wfile.write(f"{len(b):x}\r\n".encode() + b + b"\r\n")
                self.wfile.flush()

            try:
                pieces = [PROMPT[i:i + 23] for i in range(0, len(PROMPT), 23)]
                if slow:
                    pieces = pieces * 40
                for n, piece in enumerate(pieces):
                    ev = {"candidates": [{"content": {"parts": [{"text": piece}], "role": "model"}, "index": 0}], "modelVersion": "mock-1"}
                    if n == len(pieces) - 1:
                        ev["candidates"][0]["finishReason"] = "STOP"
                        ev["usageMetadata"] = {"promptTokenCount": 50, "candidatesTokenCount": 90, "totalTokenCount": 140}
                    # Split each event's BYTES in two network chunks, often inside a
                    # multi-byte character, to exercise the SSE parser's buffering.
                    data = ("data: " + json.dumps(ev, ensure_ascii=False) + "\r\n\r\n").encode()
                    cut = len(data) // 2
                    chunk(data[:cut])
                    chunk(data[cut:])
                    time.sleep(0.25 if slow else 0.02)
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                LOG.append({"event": "client closed stream"})
            return
        self.send_json(404, {"error": {"code": 404, "message": "not found", "status": "NOT_FOUND"}})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    a = ap.parse_args()
    print(f"mock Gemini API on http://127.0.0.1:{a.port}/v1beta", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
