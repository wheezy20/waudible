#!/bin/bash
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$APP_DIR/venv/bin/activate"
cd "$APP_DIR"

# Plain http locally, so secure-only cookies are off unless set otherwise
export WAUDIBLE_SECURE_COOKIES="${WAUDIBLE_SECURE_COOKIES:-0}"

# Start Flask in background
python run.py &
FLASK_PID=$!

# Wait for Flask to start
sleep 3

# Open in browser
xdg-open http://localhost:5000

# Keep alive
wait $FLASK_PID
