#!/usr/bin/env bash
# Run the planner locally: build it, serve it on 127.0.0.1, open the browser.
#
#   ./run.sh              planner from the catalog in data/ (no network)
#   ./run.sh --refresh    pull the live catalog first, then run
#   ./run.sh --test       the test harness: stub team store, ?as=<name> per person
#   PORT=9000 ./run.sh    use another port (default 8790)
#   NO_OPEN=1 ./run.sh    serve without opening a browser
#
# Locally there is no shared team store, so plans stay in this browser.
# Needs only python3.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8790}"
PAGE="reinvent-2026-planner.html"
REFRESH=0

for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH=1 ;;
    --test)    PAGE="TEST-harness.html?as=${USER:-me}" ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ "$REFRESH" = 1 ]; then
  python3 build.py
elif [ ! -f dist/reinvent-2026-planner.html ]; then
  python3 build.py --offline
fi
case "$PAGE" in TEST-*) python3 tools/make_test_build.py ;; esac

URL="http://127.0.0.1:$PORT/$PAGE"
echo "Serving $URL  (Ctrl-C to stop)"
[ -n "${NO_OPEN:-}" ] || (
  sleep 1
  if command -v open >/dev/null; then open "$URL"
  elif command -v xdg-open >/dev/null; then xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

# The page relies on its host for a charset, so declare UTF-8 here.
exec python3 - "$PORT" <<'PY'
import functools, http.server, sys
H = http.server.SimpleHTTPRequestHandler
H.extensions_map = {**H.extensions_map, ".html": "text/html; charset=utf-8"}
srv = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])),
                                      functools.partial(H, directory="dist"))
try: srv.serve_forever()
except KeyboardInterrupt: pass
PY
