#!/usr/bin/env python3
"""Tiny DFlow /order quote helper for the Bun trader.

Usage:
  python3 scripts/dflow-quote.py <inputMint> <outputMint> <amountAtomic>

The trader parses printed inAmount/outAmount lines. If DFLOW_API_KEY is absent
or the endpoint is unavailable, this exits non-zero and the TypeScript feed
falls back to stale/unknown data.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: dflow-quote.py <inputMint> <outputMint> <amountAtomic>", file=sys.stderr)
        return 2
    api_key = os.environ.get("DFLOW_API_KEY")
    if not api_key:
        print("missing DFLOW_API_KEY", file=sys.stderr)
        return 3
    input_mint, output_mint, amount = sys.argv[1:]
    base = (
        os.environ.get("DFLOW_QUOTE_API_URL")
        or os.environ.get("DFLOW_BASE_URL")
        or "https://quote-api.dflow.net"
    ).rstrip("/")
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": amount,
    }
    user_public_key = os.environ.get("DFLOW_USER_PUBLIC_KEY")
    if user_public_key:
        params["userPublicKey"] = user_public_key
    url = f"{base}/order?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "accept": "application/json",
            "x-api-key": api_key,
            "user-agent": "jev-trader-solana/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=float(os.environ.get("DFLOW_HTTP_TIMEOUT", "12"))) as res:
            body = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print(f"dflow http {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}", file=sys.stderr)
        return 4
    except Exception as exc:
        print(f"dflow request failed: {exc}", file=sys.stderr)
        return 5

    in_amount = body.get("inAmount") or body.get("inputAmount") or body.get("amount")
    out_amount = body.get("outAmount") or body.get("outputAmount")
    if isinstance(body.get("order"), dict):
        in_amount = in_amount or body["order"].get("inAmount")
        out_amount = out_amount or body["order"].get("outAmount")
    if not in_amount or not out_amount:
        print(f"dflow response missing amounts: {json.dumps(body)[:400]}", file=sys.stderr)
        return 6
    print(f"inAmount: {in_amount}")
    print(f"outAmount: {out_amount}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
