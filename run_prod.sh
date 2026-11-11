#!/bin/bash
# Production server: gunicorn on 127.0.0.1:8000, one worker process.
# Settings live in gunicorn.conf.py. Debug is always off here.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
source venv/bin/activate
unset WAUDIBLE_DEBUG
exec gunicorn --config gunicorn.conf.py
