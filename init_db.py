"""Create the users, books and progress tables in Neon.

Uses the direct (unpooled) connection, as recommended for schema changes.
Safe to run more than once: create_all() skips tables that already exist.
Usage: python init_db.py
"""
from flask import Flask
from sqlalchemy import inspect

from app.config import database_url
from app.models import db

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"]   = database_url(unpooled=True)
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}
db.init_app(app)

with app.app_context():
    db.create_all()
    tables = sorted(inspect(db.engine).get_table_names())
    print(f"Tables in database: {', '.join(tables)}")
