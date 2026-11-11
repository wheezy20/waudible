#!/bin/bash
# Runs every test suite against a temporary Neon branch (never production).
# DATABASE_URL and DATABASE_URL_UNPOOLED must point at the branch; see
# tests/README.md. Usage: ./run_tests.sh [suite ...]   (default: all)
# TEST_TIMEOUT=<seconds> overrides every suite's time limit.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
PY=venv/bin/python

ALL=(auth books worker reqlog prod nav back media offline)
SUITES=("${@:-${ALL[@]}}")

# Refuse straight away if this would touch production (the guard in tests/helpers.py)
$PY -c "import sys; sys.path.insert(0, 'tests'); import helpers" || exit 2

# Every file the app writes goes to a temporary folder, never data/
export WAUDIBLE_DATA_DIR="$(mktemp -d -t waudible-test-data-XXXXXX)"
LOGS="$WAUDIBLE_DATA_DIR/logs"; mkdir -p "$LOGS"

cleanup() {
    trap - EXIT INT TERM
    if [ -f "$WAUDIBLE_DATA_DIR/gunicorn.pid" ]; then
        kill -TERM -- "-$(cat "$WAUDIBLE_DATA_DIR/gunicorn.pid")" 2>/dev/null
    fi
    echo
    timeout 120 $PY tests/cleanup.py || echo "cleanup: FAILED, run '$PY tests/cleanup.py' again"
    rm -rf "$WAUDIBLE_DATA_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command_for() {
    case "$1" in
        auth|books|worker|reqlog|prod) echo "$PY tests/test_$1.py" ;;
        nav|back|media|offline)                echo "$PY tests/browser/server.py $1_check.js" ;;
        *) return 1 ;;
    esac
}
timeout_for() {
    if [ -n "${TEST_TIMEOUT:-}" ]; then echo "$TEST_TIMEOUT"; return; fi
    case "$1" in
        nav|back|media|offline) echo 900 ;;
        prod)           echo 600 ;;
        *)              echo 400 ;;
    esac
}

declare -A RESULT
start_all=$(date +%s)
for suite in "${SUITES[@]}"; do
    cmd=$(command_for "$suite") || { RESULT[$suite]="UNKNOWN SUITE"; continue; }
    case "$suite" in nav|back|media|offline)
        if [ ! -d tests/browser/node_modules/puppeteer-core ]; then
            RESULT[$suite]="SKIPPED (run: npm install --prefix tests/browser)"; continue
        fi
    esac
    echo "######## $suite"
    start=$(date +%s)
    timeout --kill-after=20 "$(timeout_for "$suite")" $cmd 2>&1 | tee "$LOGS/$suite.log"
    code=${PIPESTATUS[0]}
    secs=$(( $(date +%s) - start ))
    line=$(grep -E '^RESULT ' "$LOGS/$suite.log" | tail -1 | sed -E 's/^RESULT [^:]*: //')
    if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
        RESULT[$suite]="FAILED (timed out after ${secs}s) ${line}"
    elif [ "$code" -eq 2 ] && [ -z "$line" ]; then
        RESULT[$suite]="REFUSED (see above)"
    elif [ -z "$line" ]; then
        RESULT[$suite]="FAILED (crashed, exit $code)"
    elif [ "$code" -eq 0 ]; then
        RESULT[$suite]="ok      $line (${secs}s)"
    else
        RESULT[$suite]="FAILED  $line (${secs}s)"
    fi
done

echo
echo "======== Summary ($(( $(date +%s) - start_all ))s)"
failed=0
for suite in "${SUITES[@]}"; do
    printf "  %-8s %s\n" "$suite" "${RESULT[$suite]}"
    case "${RESULT[$suite]}" in ok*|SKIPPED*) ;; *) failed=1 ;; esac
done
[ "$failed" -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $failed
