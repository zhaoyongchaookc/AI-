#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="127.0.0.1"
PORT="${PORT:-4173}"
URL="http://${HOST}:${PORT}/index.html"
PID_FILE="${SCRIPT_DIR}/.loan_calculator_server.pid"
LOG_FILE="${SCRIPT_DIR}/.loan_calculator_server.log"

is_running() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

port_in_use() {
  lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1
}

if is_running; then
  echo "Local server is already running on ${URL}"
elif port_in_use; then
  echo "Port ${PORT} is already in use."
  echo "If this is the calculator service, the page will still open."
else
  cd "${SCRIPT_DIR}"
  nohup python3 -m http.server "${PORT}" --bind "${HOST}" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  sleep 1
  echo "Started local server on ${URL}"
  echo "Log file: ${LOG_FILE}"
fi

open "${URL}"
echo "Opened ${URL}"
