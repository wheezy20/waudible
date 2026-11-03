from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# ─────────────────────────────────────────
# RATE LIMITS
# Keyed by client IP. Behind the Cloudflare Tunnel, ProxyFix
# (app/main.py) sets remote_addr to the real client address.
# In-memory storage is fine because there is exactly one
# gunicorn worker process.
# ─────────────────────────────────────────
limiter = Limiter(get_remote_address, storage_uri="memory://")

AUTH_LIMIT   = "10 per minute"
UPLOAD_LIMIT = "20 per hour"
