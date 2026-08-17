#!/usr/bin/env bash
# Safely restart the dsh web bridge so the stuck-agent fix (commit 179de31)
# is loaded. MUST be run OUTSIDE the dsh process (from a normal terminal /
# WSL shell), because dsh hosts its own GUI + agents.
#   bash /home/zand/proj/dsh-lark-link/scripts/restart-dsh.sh
set -euo pipefail

BIN="/home/zand/.nvm/versions/node/v24.16.0/bin/dsh"
WORKDIR="/home/zand/proj/dsh-lark-link"
LOG="/tmp/dsh-web-restart.log"
PORT=3080

# Match both invocation styles: "dsh web" and "dsh --profile web".
OLD_PID=$(pgrep -f "bin/dsh (web|--profile web)" | head -1 || true)

if [ -z "${OLD_PID}" ]; then
  echo "[restart] no running 'dsh --profile web' process found; starting fresh…"
else
  echo "[restart] stopping old pid ${OLD_PID} (brief GUI/session gap)…"
  kill "${OLD_PID}" 2>/dev/null || true
  for i in $(seq 1 30); do
    if ! kill -0 "${OLD_PID}" 2>/dev/null; then break; fi
    sleep 0.5
  done
  # Let the port fully release.
  for i in $(seq 1 20); do
    if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" --max-time 1; then break; fi
    sleep 0.5
  done
fi

echo "[restart] launching new dsh --profile web…"
cd "$WORKDIR"
HOME=/home/zand nohup "$BIN" --profile web >"$LOG" 2>&1 &

echo "[restart] waiting for new instance on http://127.0.0.1:${PORT}/ …"
for i in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" --max-time 2; then
    echo "[restart] OK — new dsh is up. Live log: ${LOG}"
    exit 0
  fi
  sleep 1
done
echo "[restart] ERROR — new instance did not come up on ${PORT} within 40s. Check ${LOG}"
exit 1
