#!/bin/bash
# JEV trader watchdog: keeps the mock dry-run trader backend + dashboard poller alive.
# Runs every 5 min via cron (jev-backend-watchdog). Silent on success.
# NOTE (2026-09-25): the Cloudflare tunnel approach was abandoned — this
# sandbox blocks UDP DNS and direct TCP egress, so cloudflared could never
# establish edge connections. Public serving is now: VM poller ->
# worker /api/jev/ingest -> Redis -> /api/jev/feed + jev-api.musebook.trade
# (worker route). No tunnel needed.
set -u
DIR="/home/hatch/workspace/jev-trader-solana"
LOG="$DIR/data/backend.log"
POLLER_LOG="$DIR/data/jev-poller.log"
BUN="/opt/hatch-image/bin/bun"

# --- 1. Trader backend on :3000 ---
if ! curl -s --max-time 8 http://127.0.0.1:3000/ | grep -q '"dryRun":true'; then
  echo "[$(date -u +%FT%TZ)] watchdog: backend down, restarting" >> "$LOG"
  pat="bun run src/ind"[e]"x.ts"; pkill -f "$pat" 2>/dev/null || true
  sleep 2
  cd "$DIR"
  nohup env MODEL=mock VENUE=multi DRY_RUN=true PORT=3000 "$BUN" run src/index.ts >> "$LOG" 2>&1 &
  echo "[$(date -u +%FT%TZ)] watchdog: backend restarted pid $!" >> "$LOG"
fi

# --- 2. Dashboard poller (pushes snapshots to the worker ingest) ---
pat="jev-poll"[e]"r.py"
if ! pgrep -f "$pat" > /dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] watchdog: poller down, restarting" >> "$POLLER_LOG"
  cd "$DIR"
  nohup python3 "$DIR/jev-poller.py" >> "$POLLER_LOG" 2>&1 &
  echo "[$(date -u +%FT%TZ)] watchdog: poller restarted pid $!" >> "$POLLER_LOG"
fi
