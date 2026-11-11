import logging
import re
import time
from flask import g, request
from sqlalchemy import event
from sqlalchemy.engine import Engine

log = logging.getLogger(__name__)

# ─────────────────────────────────────────
# SLOW REQUESTS AND DATABASE CONNECT ERRORS
# One WARNING line per request slower than
# SLOW_REQUEST_SECONDS, with the method, the route
# pattern (never the real path or query string, so
# ids and tokens stay out of the log), the status and
# the time. No bodies, cookies, users or emails.
# Lines go to stderr, so systemd keeps them in the
# journal (journalctl -u waudible).
# ─────────────────────────────────────────
SLOW_REQUEST_SECONDS = 3.0

_QUOTED = re.compile(r'"[^"]*"')
_IPV4   = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_IPV6   = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b")


def init_request_logging(app):
    """Call right after creating the app, so the timer starts before other hooks."""
    app.before_request(_start_timer)
    app.after_request(_log_if_slow)


def _start_timer():
    g._request_start = time.perf_counter()


def _log_if_slow(response):
    start = g.get("_request_start")
    if start is not None:
        seconds = time.perf_counter() - start
        if seconds > SLOW_REQUEST_SECONDS:
            rule = request.url_rule.rule if request.url_rule is not None else "(no matching route)"
            log.warning("Slow request: %s %s %s in %.2f s",
                        request.method, rule, response.status_code, seconds)
    return response


def _safe_db_message(exc, url) -> str:
    """First line of a driver error, without hosts, users, database names or addresses."""
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    for secret in (url.password, url.username, url.host, url.database):
        if secret:
            text = text.replace(str(secret), "***")
    text = _QUOTED.sub('"***"', text)
    text = _IPV6.sub("***", _IPV4.sub("***", text))
    return text[:200]


@event.listens_for(Engine, "handle_error")
def _log_connect_error(ctx):
    # No connection yet means the error happened while connecting. Failed
    # pre-pings are retried by the pool, so only the real failure is logged.
    if ctx.connection is not None or ctx.is_pre_ping:
        return
    exc = ctx.original_exception
    log.error("Database connect error: %s: %s",
              type(exc).__name__, _safe_db_message(exc, ctx.engine.url))
