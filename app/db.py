import os
from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# Load .env / .env.local written by `neon deploy` / `neon env pull`
ROOT_DIR = os.path.join(os.path.dirname(__file__), '..')
load_dotenv(os.path.join(ROOT_DIR, '.env.local'))
load_dotenv(os.path.join(ROOT_DIR, '.env'))

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set — run `neon env pull`")

# Pooled URL (-pooler) for app traffic. PgBouncer runs in transaction mode,
# so disable server-side prepared statements.
pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=5,
    kwargs={"row_factory": dict_row, "prepare_threshold": None},
    open=False,
)


def get_pool() -> ConnectionPool:
    if pool.closed:
        pool.open(wait=True, timeout=30)
    return pool
