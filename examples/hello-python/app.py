"""Minimal HTTP app with no Dockerfile: SCAD's Python template builds it (T2.4)."""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Hello(BaseHTTPRequestHandler):
    def do_GET(self):
        who = self.headers.get("X-SCAD-User-Email", "stranger")
        body = f"hello-python says hi to {who}\n".encode()
        self.send_response(200)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


port = int(os.environ.get("PORT", "8080"))
print(f"hello-python listening on {port}", flush=True)
ThreadingHTTPServer(("0.0.0.0", port), Hello).serve_forever()
