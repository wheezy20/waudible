from datetime import datetime, timezone
from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────
# USERS
# ─────────────────────────────────────────
class User(UserMixin, db.Model):
    __tablename__ = "users"

    id            = db.Column(db.Integer, primary_key=True)
    email         = db.Column(db.String(255), unique=True, nullable=False)
    display_name  = db.Column(db.String(100), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at    = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)

    # Deleting a user deletes their books (and through them, progress)
    books = db.relationship("Book", back_populates="user",
                            cascade="all, delete-orphan", passive_deletes=True)

    def set_password(self, password: str):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


# ─────────────────────────────────────────
# BOOKS
# Files live under storage_key, never under
# the uploaded filename
# ─────────────────────────────────────────
class Book(db.Model):
    __tablename__ = "books"

    id            = db.Column(db.Integer, primary_key=True)
    user_id       = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                              nullable=False, index=True)
    storage_key   = db.Column(db.String(64), unique=True, nullable=False)
    original_name = db.Column(db.String(255), nullable=False)
    title         = db.Column(db.String(255), nullable=False)
    author        = db.Column(db.String(255))
    pages         = db.Column(db.Integer, nullable=False, default=0)
    genre         = db.Column(db.String(100), nullable=False, default="Other")
    cover         = db.Column(db.String(255))
    status        = db.Column(db.String(20), nullable=False, default="processing")
    pages_done    = db.Column(db.Integer, nullable=False, default=0)
    created_at    = db.Column(db.DateTime(timezone=True), nullable=False, default=_now)

    __table_args__ = (
        db.CheckConstraint("status IN ('processing', 'ready')", name="books_status_check"),
    )

    user     = db.relationship("User", back_populates="books")
    progress = db.relationship("Progress", back_populates="book", uselist=False,
                               cascade="all, delete-orphan", passive_deletes=True)


# ─────────────────────────────────────────
# PROGRESS
# One row per book, since every book has
# exactly one owner
# ─────────────────────────────────────────
class Progress(db.Model):
    __tablename__ = "progress"

    id           = db.Column(db.Integer, primary_key=True)
    book_id      = db.Column(db.Integer, db.ForeignKey("books.id", ondelete="CASCADE"),
                             unique=True, nullable=False)
    current_page = db.Column(db.Integer, nullable=False, default=0)
    speed        = db.Column(db.Float, nullable=False, default=1.0)
    voice        = db.Column(db.String(50), nullable=False, default="af_heart")
    updated_at   = db.Column(db.DateTime(timezone=True), nullable=False,
                             default=_now, onupdate=_now)

    book = db.relationship("Book", back_populates="progress")
