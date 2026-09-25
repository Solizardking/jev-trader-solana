#!/usr/bin/env python3
"""Dev-only JSON-RPC bridge: forwards local POSTs to Helius mainnet with the
stored custom.helius credential (surrogate query param, replaced by Sentinel on
egress). Lets the Bun service use Helius without ever seeing the raw API key.

    python3 scripts/rpc-bridge.py [--port 8899]

Then: RPC_URL=http://127.0.0.1:8899 bun run src/index.ts
"""
import argparse
import json
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import url_with_surrogate_query_param

HOST = "https://mainnet.helius-rpc.com/"


class Handler(BaseHTTPRequestHandler):
    target = ""

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        req = urllib.request.Request(
            self.target, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                out = resp.read()
            self.send_response(200)
        except Exception as e:  # noqa: BLE001 - dev bridge, surface the error
            out = json.dumps(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": str(e)}}
            ).encode()
            self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    args = ap.parse_args()
    Handler.target = url_with_surrogate_query_param(
        HOST, "custom.helius", allowed_hosts=["mainnet.helius-rpc.com"]
    )
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"rpc-bridge listening on 127.0.0.1:{args.port} -> {HOST}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
