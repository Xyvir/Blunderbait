"""
server.py — BBI Dev server with no-cache headers
Run: python3 server.py
"""
import http.server, socketserver, os

PORT = 3033
DIRECTORY = r"c:\Users\temp\BBI_Dev"

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # CORS for onnxruntime-web wasm fetch
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # quiet

with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving BBI_Dev on http://localhost:{PORT}")
    httpd.serve_forever()
