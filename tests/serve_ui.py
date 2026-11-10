"""Serve ui/ for the browser-pane harness, with tests/mock-tauri.js injected
in place of the Rust backend. Usage: python tests/serve_ui.py --port 8765"""
import argparse
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
MOCK = ROOT / "tests" / "mock-tauri.js"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path in ("/", "/index.html"):
            html = (UI / "index.html").read_text(encoding="utf-8")
            html = html.replace('<script type="module" src="app.js">', '<script src="/__mock/mock-tauri.js"></script>\n<script type="module" src="app.js">', 1)
            return self.send(html.encode("utf-8"), ".html")
        if path == "/__mock/mock-tauri.js":
            return self.send(MOCK.read_bytes(), ".js")
        target = (UI / path.lstrip("/")).resolve()
        if UI not in target.parents or not target.is_file():
            self.send_error(404)
            return
        self.send(target.read_bytes(), target.suffix)

    def send(self, data, suffix):
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(suffix, "application/octet-stream") + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    print(f"UI harness on http://127.0.0.1:{a.port}/", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
