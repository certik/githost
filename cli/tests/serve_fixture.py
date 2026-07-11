#!/usr/bin/env python3
"""
Minimal HTTP server that serves a fixed /api/prs JSON fixture.

Prints the base URL (http://127.0.0.1:<port>) on stdout and runs until killed.
Used by cli/tests/run_tests.sh so the C CLI talks to a deterministic local API.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--fixture",
        type=Path,
        default=Path(__file__).resolve().parent / "fixtures" / "api_prs.json",
    )
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0, help="0 = ephemeral free port")
    args = ap.parse_args()

    body = args.fixture.read_bytes()
    # Validate JSON early so tests fail loudly on a bad fixture.
    json.loads(body.decode("utf-8"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *a) -> None:  # silence request logs
            return

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/api/prs" or path.startswith("/api/prs?"):
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')

    httpd = HTTPServer((args.host, args.port), Handler)
    host, port = httpd.server_address[:2]
    # Announce base URL for the test harness (no trailing slash).
    sys.stdout.write(f"http://{host}:{port}\n")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
