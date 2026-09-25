#!/usr/bin/env python3
"""JEV dashboard poller: pushes trader snapshots to the worker ingest endpoint.

Runs as a persistent loop (supervised by watchdog.sh). Every 30s it reads the
local trader backend (localhost:3000) and POSTs a snapshot to
https://musebook.trade/api/jev/ingest, which stores it in Redis for the
/jev/ page and the jev-api.musebook.trade public API.
"""
import http.client
import json
import os
import time
import urllib.request

TRADER = ("127.0.0.1", 3000)
INGEST_URL = "https://musebook.trade/api/jev/ingest"
SECRET_PATH = "/home/hatch/workspace/jev-trader-solana/data/jev-ingest-secret"
INTERVAL = 30

def get(path):
    conn = http.client.HTTPConnection(TRADER[0], TRADER[1], timeout=10)
    try:
        conn.request("GET", path)
        r = conn.getresponse()
        if r.status != 200:
            return None
        return json.loads(r.read().decode())
    except Exception as e:
        print(f"[jev-poller] GET {path} failed: {e}", flush=True)
        return None
    finally:
        conn.close()

def post(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(INGEST_URL, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception as e:
        print(f"[jev-poller] ingest POST failed: {e}", flush=True)
        return False

def main():
    secret = open(SECRET_PATH).read().strip()
    print("[jev-poller] started", flush=True)
    while True:
        status = get("/")
        history = get("/history")
        regime = get("/regime")
        if status is not None:
            ok = post({"secret": secret, "status": status,
                       "history": history, "regime": regime})
            print(f"[jev-poller] pushed: {ok}", flush=True)
        else:
            print("[jev-poller] trader not responding, skipping", flush=True)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
