#!/usr/bin/env bash
#
# start.sh — run the GoPro gallery stack:
#   * the Python REST API   (gopro.py serve)
#   * the Node gallery UI    (gallery/server.js, which proxies that API)
#
# Settings come from gopro.conf next to this script (override the path with
# GOPRO_CONFIG). Usage:
#
#   ./start.sh [restart|start|stop|status]      (default: restart)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${GOPRO_CONFIG:-$SCRIPT_DIR/gopro.conf}"

# Defaults — overridden by anything set in the config file.
MEDIA_DIR="/Volumes/LaCie/media"
API_HOST="127.0.0.1"
API_PORT="8787"
GALLERY_PORT="3000"
PYTHON="python3"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

RUN_DIR="$SCRIPT_DIR/.run"
mkdir -p "$RUN_DIR"
API_PID_FILE="$RUN_DIR/api.pid"
API_LOG="$RUN_DIR/api.log"
GALLERY_PID_FILE="$RUN_DIR/gallery.pid"
GALLERY_LOG="$RUN_DIR/gallery.log"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Echo the pid in a pidfile, but only if it names a live process.
pid_of() {
  local f="$1" pid
  [[ -f "$f" ]] || return 1
  pid="$(cat "$f" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { printf '%s' "$pid"; return 0; }
  return 1
}

stop_one() {  # name pidfile
  local name="$1" f="$2" pid n=0
  if pid="$(pid_of "$f")"; then
    log "Stopping $name (pid $pid)…"
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
      sleep 0.2
      n=$((n + 1))
      if (( n >= 25 )); then          # ~5s grace, then force
        warn "$name did not exit; sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
        break
      fi
    done
  fi
  rm -f "$f"
}

wait_http() {  # url
  local url="$1" n=0
  while (( n < 40 )); do               # ~10s
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 0.25
    n=$((n + 1))
  done
  return 1
}

start_api() {
  if pid_of "$API_PID_FILE" >/dev/null; then
    log "API already running (pid $(cat "$API_PID_FILE"))."
    return 0
  fi
  [[ -d "$MEDIA_DIR" ]] || die "media directory not found: $MEDIA_DIR
  Plug in the drive, or edit MEDIA_DIR in $CONFIG_FILE."
  command -v "$PYTHON" >/dev/null || die "$PYTHON not found on PATH"
  log "Starting API: serve \"$MEDIA_DIR\" on $API_HOST:$API_PORT"
  nohup "$PYTHON" "$SCRIPT_DIR/gopro.py" serve "$MEDIA_DIR" \
    --host "$API_HOST" --port "$API_PORT" >"$API_LOG" 2>&1 &
  echo $! >"$API_PID_FILE"
  if wait_http "http://$API_HOST:$API_PORT/health"; then
    log "  API ready: http://$API_HOST:$API_PORT/api/media"
  else
    warn "API did not become healthy — see $API_LOG"
  fi
}

start_gallery() {
  if pid_of "$GALLERY_PID_FILE" >/dev/null; then
    log "Gallery already running (pid $(cat "$GALLERY_PID_FILE"))."
    return 0
  fi
  command -v node >/dev/null || die "node not found on PATH"
  if [[ ! -d "$SCRIPT_DIR/gallery/node_modules" ]]; then
    warn "gallery/node_modules missing — running npm install"
    ( cd "$SCRIPT_DIR/gallery" && npm install ) || die "npm install failed"
  fi
  log "Starting gallery on port $GALLERY_PORT (proxying http://$API_HOST:$API_PORT)"
  PORT="$GALLERY_PORT" GOPRO_API="http://$API_HOST:$API_PORT" \
    nohup node "$SCRIPT_DIR/gallery/server.js" >"$GALLERY_LOG" 2>&1 &
  echo $! >"$GALLERY_PID_FILE"
  if wait_http "http://127.0.0.1:$GALLERY_PORT/"; then
    log "  Gallery ready: http://localhost:$GALLERY_PORT"
  else
    warn "gallery did not respond — see $GALLERY_LOG"
  fi
}

status() {
  local p
  if p="$(pid_of "$API_PID_FILE")"; then
    log "API:     running (pid $p) — http://$API_HOST:$API_PORT/api/media"
  else
    log "API:     stopped"
  fi
  if p="$(pid_of "$GALLERY_PID_FILE")"; then
    log "Gallery: running (pid $p) — http://localhost:$GALLERY_PORT"
  else
    log "Gallery: stopped"
  fi
  log "Media:   $MEDIA_DIR"
  log "Logs:    $API_LOG"
  log "         $GALLERY_LOG"
}

case "${1:-restart}" in
  start)
    start_api
    start_gallery
    ;;
  stop)
    stop_one "gallery" "$GALLERY_PID_FILE"
    stop_one "API" "$API_PID_FILE"
    ;;
  restart)
    stop_one "gallery" "$GALLERY_PID_FILE"
    stop_one "API" "$API_PID_FILE"
    start_api
    start_gallery
    ;;
  status)
    status
    ;;
  *)
    die "usage: $(basename "$0") [restart|start|stop|status]"
    ;;
esac
