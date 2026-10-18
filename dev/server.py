#!/usr/bin/env python3
"""開發用靜態伺服器：在擴充功能的 HTML 頁面前插入 dev/shim.js，模擬 Safari 擴充功能 API。"""
import http.server
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SHIM = b'<script src="/dev/shim.js"></script>'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/extension/') and path.endswith('.html'):
            fs = os.path.join(ROOT, path.lstrip('/'))
            if os.path.isfile(fs):
                with open(fs, 'rb') as f:
                    body = f.read().replace(b'<script', SHIM + b'\n  <script', 1)
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
