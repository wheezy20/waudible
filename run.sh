#!/bin/bash
# Local development on http://localhost:5000 (not for production, see run_prod.sh)
source venv/bin/activate
# Plain http locally, so secure-only cookies are off unless set otherwise
export WAUDIBLE_SECURE_COOKIES="${WAUDIBLE_SECURE_COOKIES:-0}"
echo "Starting WAudible at http://localhost:5000"
python run.py
