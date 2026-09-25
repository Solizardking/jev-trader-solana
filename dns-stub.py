#!/usr/bin/env python3
"""Minimal DNS stub for the JEV tunnel host.

Answers cloudflared's edge-discovery queries locally; forwards everything
else via DNS-over-HTTPS through the egress proxy.

Overrides:
  SRV _v2-origintunneld._tcp.argotunnel.com -> edge1..4.stub.invalid:7844
  A   edgeN.stub.invalid                    -> real Cloudflare edge IPs
"""
import json
import os
import socket
import struct
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler  # noqa: F401  (import warmup)

EDGE_IPS = ["198.41.192.77", "198.41.192.7", "198.41.192.67", "198.41.192.167"]
SRV_NAME = b"_v2-origintunneld._tcp.argotunnel.com"

# Refresh edge IPs via DoH (through proxy env) at startup.
def refresh_edge_ips():
    try:
        req = urllib.request.Request(
            "https://cloudflare-dns.com/dns-query?name=region1.v2.argotunnel.com&type=A",
            headers={"accept": "application/dns-json"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
        ips = [a["data"] for a in d.get("Answer", []) if a.get("type") == 1]
        if len(ips) >= 2:
            EDGE_IPS[:] = ips[:4]
    except Exception as e:
        print(f"[dns-stub] edge refresh failed, using baked-in: {e}", flush=True)

def doh_forward(query: bytes) -> bytes | None:
    """Forward a raw DNS query via DNS-over-HTTPS (POST, RFC 8484)."""
    try:
        req = urllib.request.Request(
            "https://cloudflare-dns.com/dns-query",
            data=query,
            headers={"content-type": "application/dns-message",
                     "accept": "application/dns-message"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()
    except Exception:
        return None

def decode_name(buf: bytes, off: int):
    labels = []
    jumped = False
    orig_off = off
    while True:
        ln = buf[off]
        if ln == 0:
            off += 1
            break
        if ln & 0xC0:
            ptr = struct.unpack(">H", buf[off:off + 2])[0] & 0x3FFF
            if not jumped:
                orig_off = off + 2
            off = ptr
            jumped = True
            continue
        off += 1
        labels.append(buf[off:off + ln])
        off += ln
    return b".".join(labels).lower(), (orig_off if jumped else off)

def build_response(query: bytes) -> bytes | None:
    if len(query) < 12:
        return None
    tid, flags, qd, an, ns, ar = struct.unpack(">HHHHHH", query[:12])
    off = 12
    questions = []
    for _ in range(qd):
        name, off = decode_name(query, off)
        qtype, qclass = struct.unpack(">HH", query[off:off + 4])
        off += 4
        questions.append((name, qtype, qclass))
    if not questions:
        return None
    name, qtype, _ = questions[0]

    answers = b""
    count = 0
    if name == SRV_NAME.lower() and qtype == 33:  # SRV
        for i in range(len(EDGE_IPS)):
            target = f"edge{i+1}.stub.invalid".encode()
            rdata = struct.pack(">HHH", 0, 1, 7844)
            for lab in target.split(b"."):
                rdata += bytes([len(lab)]) + lab
            rdata += b"\x00"
            answers += struct.pack(">HHHIH", 0xC00C, 33, 1, 60, len(rdata)) + rdata
            count += 1
    elif name.startswith(b"edge") and name.endswith(b".stub.invalid") and qtype == 1:
        try:
            idx = int(name[4:5]) - 1
            ip = EDGE_IPS[idx]
            answers += struct.pack(">HHHIH", 0xC00C, 1, 1, 60, 4) + socket.inet_aton(ip)
            count += 1
        except (ValueError, IndexError):
            pass
    else:
        # Not ours: forward via DoH and relay the raw response.
        return doh_forward(query)

    resp = struct.pack(">HHHHHH", tid, 0x8180, qd, count, 0, 0)
    resp += query[12:off]  # echo question section
    resp += answers
    return resp

def handle_udp(sock: socket.socket):
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            resp = build_response(data)
            if resp:
                sock.sendto(resp, addr)
        except Exception:
            pass

def handle_tcp(conn: socket.socket):
    try:
        ln = struct.unpack(">H", conn.recv(2))[0]
        data = b""
        while len(data) < ln:
            chunk = conn.recv(ln - len(data))
            if not chunk:
                return
            data += chunk
        resp = build_response(data)
        if resp:
            conn.sendall(struct.pack(">H", len(resp)) + resp)
    except Exception:
        pass
    finally:
        conn.close()

def main():
    refresh_edge_ips()
    print(f"[dns-stub] edge IPs: {EDGE_IPS}", flush=True)
    usock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    usock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    usock.bind(("127.0.0.1", 53))
    tsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tsock.bind(("127.0.0.1", 53))
    tsock.listen(16)
    threading.Thread(target=handle_udp, args=(usock,), daemon=True).start()
    print("[dns-stub] listening on 127.0.0.1:53", flush=True)
    while True:
        conn, _ = tsock.accept()
        threading.Thread(target=handle_tcp, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
