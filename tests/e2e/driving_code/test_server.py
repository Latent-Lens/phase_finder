"""Isolated source/dist test server that never exposes local autoload state."""

import http.server
import socketserver
import threading
from pathlib import Path


def is_hidden_test_path(path):
    return path.split("?", 1)[0] == "/sessions/phasefinder_local.json"


def production_headers(directory):
    path = Path(directory) / "_headers"
    if not path.exists():
        return []
    headers = []
    for line in path.read_text().splitlines():
        if not line.startswith((" ", "\t")) or ":" not in line:
            continue
        name, value = line.strip().split(":", 1)
        headers.append((name, value.strip()))
    return headers


def start_test_server(directory):
    headers = production_headers(directory)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            if is_hidden_test_path(self.path):
                self.send_error(404)
                return
            super().do_GET()

        def end_headers(self):
            for name, value in headers:
                self.send_header(name, value)
            super().end_headers()

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

    for port in range(8000, 9001):
        try:
            server = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
        except OSError:
            continue
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return port, server
    raise RuntimeError("No open port found in 8000–9000")
