#!/usr/bin/env bash
# Simulacra orchestrator manager
# Usage: ./scripts/orch.sh start | stop | restart | status | logs

set -euo pipefail

PIDFILE=".orch.pid"
LOGFILE="logs/orchestrator.log"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

cmd="${1:-status}"

case "$cmd" in
  start)
    if [[ -f "$PIDFILE" ]]; then
      PID=$(cat "$PIDFILE")
      if kill -0 "$PID" 2>/dev/null; then
        echo "Orchestrator already running (pid $PID). Use 'restart' to restart."
        exit 0
      fi
      rm -f "$PIDFILE"
    fi
    mkdir -p logs
    nohup npx tsx src/orchestrator.ts >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "Orchestrator started (pid $(cat "$PIDFILE")). Logs: $LOGFILE"
    ;;

  stop)
    if [[ ! -f "$PIDFILE" ]]; then
      echo "No pidfile found — orchestrator may not be running."
      exit 0
    fi
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      rm -f "$PIDFILE"
      echo "Orchestrator stopped (pid $PID)."
    else
      echo "Process $PID not found — cleaning up stale pidfile."
      rm -f "$PIDFILE"
    fi
    ;;

  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;

  status)
    if [[ ! -f "$PIDFILE" ]]; then
      echo "Orchestrator: stopped (no pidfile)"
      exit 0
    fi
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Orchestrator: running (pid $PID)"
    else
      echo "Orchestrator: stopped (stale pidfile for pid $PID)"
      rm -f "$PIDFILE"
    fi
    ;;

  logs)
    tail -f "$LOGFILE"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
