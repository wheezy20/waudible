"""gunicorn settings for production (started by run_prod.sh).

Exactly one worker process: the Kokoro model and the audio queue
worker must exist only once. Threads handle concurrent requests.
"""
wsgi_app = "app.main:app"

# Local only. The Cloudflare Tunnel (cloudflared) connects to this
# address; never bind to 0.0.0.0.
bind = "127.0.0.1:8000"

workers = 1          # never more than 1 (see above)
threads = 4
worker_class = "gthread"

# Audio for a page can be generated on demand, which takes a while
timeout = 120
graceful_timeout = 30

# Load the app inside the worker, not the master, so the model is
# loaded once in the process that serves requests
preload_app = False

accesslog = "-"
errorlog = "-"


def post_worker_init(worker):
    """Start the audio queue worker and re-queue unfinished books."""
    from app.main import app, start_worker
    start_worker(app)
