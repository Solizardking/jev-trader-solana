#!/usr/bin/env python3
"""Public TypeSafe / Jev bridge for the jev-trader-solana codebase.

Same CLI contract as the internal bridge the trader was developed against:

    jev-bridge.py ask --state "..." --questions '{"op": {...}}' [--model jev-latest]

Prints the `answers` object as JSON to stdout (exit 0). On any failure it
prints to stderr and exits non-zero; the trader treats that as a Jev failure
and fails closed (PAUSE).

Auth: uses the TYPESAFE_API_KEY environment variable against
https://api.typesafe.ai/v1/systemone (override the host with
TYPESAFE_API_URL).

Point the trader at this script with JEV_BIN:

    JEV_BIN=$PWD/scripts/jev-bridge.py TYPESAFE_API_KEY=... \\
        MODEL=jev VENUE=multi DRY_RUN=true bun run src/index.ts
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("TYPESAFE_API_URL", "https://api.typesafe.ai").rstrip("/")
ENDPOINT = "/v1/systemone"


def call_api(state, questions, model):
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        print("TYPESAFE_API_KEY is not set.", file=sys.stderr)
        sys.exit(2)
    url = f"{BASE}{ENDPOINT}"
    body = {"state": state, "model": model, "questions": questions}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:2000]
        except Exception:
            pass
        print(f"HTTP {e.code} on POST {ENDPOINT}: {detail}", file=sys.stderr)
        sys.exit(2)


def load_state(a):
    if a.stdin:
        return sys.stdin.read()
    if a.state_file:
        with open(a.state_file) as f:
            return f.read()
    return a.state


def load_questions(a):
    if a.questions_file:
        with open(a.questions_file) as f:
            return json.load(f)
    try:
        return json.loads(a.questions)
    except json.JSONDecodeError as e:
        print(f"Invalid --questions JSON: {e}", file=sys.stderr)
        sys.exit(2)


def cmd_ask(a):
    state = load_state(a)
    if not state or not state.strip():
        print("Empty state: pass --state, --state-file, or --stdin.", file=sys.stderr)
        sys.exit(2)
    questions = load_questions(a)
    if not isinstance(questions, dict) or not questions:
        print("--questions must be a non-empty JSON object of question definitions.",
              file=sys.stderr)
        sys.exit(2)
    resp = call_api(state, questions, model=a.model)
    answers = resp.get("answers", {})
    if a.compact:
        for qid, ans in answers.items():
            print(f"{qid}: {json.dumps(ans)}")
    else:
        print(json.dumps(answers, indent=2))


def main():
    p = argparse.ArgumentParser(description="Ask Jev (TypeSafe System One) typed questions.")
    sub = p.add_subparsers(dest="cmd", required=True)
    ask = sub.add_parser("ask", help="Ask typed questions against a state.")
    src = ask.add_mutually_exclusive_group(required=True)
    src.add_argument("--state", help="State text to judge.")
    src.add_argument("--state-file", help="File containing the state text.")
    src.add_argument("--stdin", action="store_true", help="Read state from stdin.")
    qsrc = ask.add_mutually_exclusive_group(required=True)
    qsrc.add_argument("--questions", help="JSON object of question definitions.")
    qsrc.add_argument("--questions-file", help="JSON file of question definitions.")
    ask.add_argument("--model", default="jev-latest", help="Model id (default: jev-latest).")
    ask.add_argument("--compact", action="store_true", help="One-line summary per question.")
    a = p.parse_args()
    if a.cmd == "ask":
        cmd_ask(a)


if __name__ == "__main__":
    main()
