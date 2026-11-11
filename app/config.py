from dotenv import load_dotenv
import os

load_dotenv()


def database_url(unpooled: bool = False) -> str:
    """Neon gives postgresql://. SQLAlchemy needs to be told to use psycopg 3."""
    key = "DATABASE_URL_UNPOOLED" if unpooled else "DATABASE_URL"
    return os.environ[key].replace("postgresql://", "postgresql+psycopg://", 1)
