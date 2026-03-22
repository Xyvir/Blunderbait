import http.server
import socketserver

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        with open('startpos.json', 'wb') as f:
            f.write(post_data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

httpd = socketserver.TCPServer(("", 8000), Handler)
print("Listening on 8000...")
httpd.handle_request() # OPTION
httpd.handle_request() # POST
httpd.server_close()
