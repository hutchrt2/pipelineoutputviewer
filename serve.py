#!/usr/bin/env python3
"""Local standard-library HTTP server for Candidate B pipeline output viewer.

Requirements:
- Python 3.9+ (Python 3.10+ recommended), standard library only.
- Confined to its bundle directory: no traversal outside bundle root.
- Binds to 127.0.0.1 by default; never opens a public listener by default.
- Works from any current working directory.
- Supports --port (including --port 0 for OS-assigned port).
- Prints URL immediately with flush.
- Handles port conflicts and missing bundle assets cleanly.
"""
from __future__ import annotations

import argparse
import http.server
import os
import signal
import sys
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parent


class ConfinedHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BUNDLE_ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        # Strip query string and fragment
        path = path.split("?", 1)[0].split("#", 1)[0]
        # Resolve path relative to BUNDLE_ROOT
        try:
            rel = path.lstrip("/")
            target = (BUNDLE_ROOT / rel).resolve()
            if not target.is_relative_to(BUNDLE_ROOT):
                # Escapes bundle root! Return dummy non-existent path
                return str(BUNDLE_ROOT / "__escaped_forbidden__")
            if target.is_symlink():
                return str(BUNDLE_ROOT / "__escaped_forbidden__")
            return str(target)
        except Exception:
            return str(BUNDLE_ROOT / "__escaped_forbidden__")

    def end_headers(self) -> None:
        # Prevent caching for local review and close connections cleanly
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        # Quiet standard output during normal operations
        pass


def check_bundle_health() -> None:
    required = [
        BUNDLE_ROOT / "index.html",
        BUNDLE_ROOT / "app.js",
        BUNDLE_ROOT / "styles.css",
        BUNDLE_ROOT / "data" / "manifest.json",
    ]
    missing = [str(p.relative_to(BUNDLE_ROOT)) for p in required if not p.is_file()]
    if missing:
        sys.stderr.write(f"Error: Bundle is missing required data or assets: {', '.join(missing)}\n")
        sys.stderr.flush()
        sys.exit(1)


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    check_bundle_health()

    class DualStackServer(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    try:
        server = DualStackServer((host, port), ConfinedHandler)
    except OSError as err:
        sys.stderr.write(f"Error: Unable to bind to {host}:{port} ({err}). Perhaps the port is already in use?\n")
        sys.stderr.flush()
        sys.exit(1)

    actual_port = server.server_address[1]
    url = f"http://{host}:{actual_port}/"
    print(f"Serving funcMap Test Viewer at {url}")
    print("Press Ctrl+C to stop.")
    sys.stdout.flush()

    def shutdown_handler(signum, frame):
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000, use 0 for random)")
    args = parser.parse_args()
    serve(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
