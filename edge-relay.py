#!/usr/bin/env python3
"""Local TCP relay: 127.0.0.1:17844 -> Cloudflare edge :7844 via egress proxy.

cloudflared in this sandbox cannot dial the edge directly (transparent TCP
interceptor blocks non-proxy egress). This relay accepts local connections
and forwards them through the authenticated HTTPS proxy with CONNECT.

Proxy credentials come from the HTTPS_PROXY env var (transient, never logged).
"""
import base64
import itertools
import os
import socket
import threading
import urllib.parse

EDGE_IPS = ["198.41.192.227", "198.41.192.7", "198.41.192.167", "198.41.192.37",
            "198.41.192.77", "198.41.192.47", "198.41.192.57", "198.41.192.67",
            "198.41.192.27", "198.41.192.107"]
EDGE_PORT = 7844
LISTEN_PORT = 17844

def get_proxy():
    p = urllib.parse.urlparse(os.environ["HTTPS_PROXY"])
    auth = base64.b64encode(f"{p.username}:{p.password}".encode()).decode()
    return p.hostname, p.port or 8080, auth

PROXY_HOST, PROXY_PORT, PROXY_AUTH = get_proxy()
edge_cycle = itertools.cycle(EDGE_IPS)

def pipe(src: socket.socket, dst: socket.socket):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def handle(client: socket.socket):
    edge_ip = next(edge_cycle)
    upstream = None
    try:
        upstream = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=15)
        upstream.sendall(
            f"CONNECT {edge_ip}:{EDGE_PORT} HTTP/1.1\r\n"
            f"Host: {edge_ip}:{EDGE_PORT}\r\n"
            f"Proxy-Authorization: Basic {PROXY_AUTH}\r\n\r\n".encode()
        )
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = upstream.recv(4096)
            if not chunk:
                raise OSError("proxy closed during CONNECT")
            resp += chunk
        if b" 200 " not in resp.split(b"\r\n", 1)[0]:
            raise OSError(f"CONNECT rejected: {resp[:80]!r}")
        t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
        t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t1.start(); t2.start()
        t1.join(); t2.join()
    except Exception as e:
        print(f"[edge-relay] {edge_ip}: {e}", flush=True)
    finally:
        for s in (client, upstream):
            if s:
                try: s.close()
                except OSError: pass

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", LISTEN_PORT))
    srv.listen(32)
    print(f"[edge-relay] listening on 127.0.0.1:{LISTEN_PORT}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
