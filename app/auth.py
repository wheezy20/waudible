import hmac
import os
from urllib.parse import urlsplit
from flask import (Blueprint, render_template, request,
                   redirect, url_for, flash)
from flask_login import (LoginManager, login_user, logout_user,
                         current_user)
from flask_wtf import FlaskForm
from sqlalchemy.exc import IntegrityError
from werkzeug.security import check_password_hash, generate_password_hash
from wtforms import StringField, PasswordField, HiddenField
from wtforms.validators import (DataRequired, Length, Regexp,
                                EqualTo, ValidationError)
from app.models import db, User
from app.limiter import limiter, AUTH_LIMIT

auth = Blueprint("auth", __name__)

login_manager = LoginManager()
login_manager.login_view = "auth.login"
login_manager.login_message = None

LOGIN_ERROR = "Incorrect email or password."

# Compared against when the email is unknown, so a wrong email
# takes as long as a wrong password
_DUMMY_HASH = generate_password_hash("waudible-timing-dummy")


@login_manager.user_loader
def load_user(user_id: str):
    return db.session.get(User, int(user_id))


def _clean_email(value):
    return value.strip().lower() if value else value


def _safe_next(target: str | None) -> str | None:
    """Only allow redirects to paths on this site (no open redirects)."""
    if not target or not target.startswith("/") or target.startswith("//"):
        return None
    # Browsers treat \ like / and drop tabs and newlines, so "/\evil.com"
    # or "/\t/evil.com" would leave the site
    if "\\" in target or any(ord(c) < 32 for c in target):
        return None
    parts = urlsplit(target)
    if parts.scheme or parts.netloc:
        return None
    return target


# ─────────────────────────────────────────
# FORMS
# ─────────────────────────────────────────
EMAIL_RULES = [DataRequired(), Length(max=255),
               Regexp(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", message="Enter a valid email address.")]


class LoginForm(FlaskForm):
    # No format check here, so every failed login gets the same message
    email    = StringField("Email", filters=[_clean_email],
                           validators=[DataRequired(), Length(max=255)])
    password = PasswordField("Password", validators=[DataRequired()])
    next     = HiddenField()


class RegisterForm(FlaskForm):
    display_name = StringField("Display name", filters=[lambda s: s.strip() if s else s],
                               validators=[DataRequired(), Length(max=100)])
    email        = StringField("Email", filters=[_clean_email], validators=EMAIL_RULES)
    password     = PasswordField("Password", validators=[
                       DataRequired(),
                       Length(min=8, message="Password must be at least 8 characters.")])
    confirm      = PasswordField("Confirm password", validators=[
                       DataRequired(),
                       EqualTo("password", message="Passwords do not match.")])
    invite_code  = PasswordField("Invite code", validators=[DataRequired()])
    next         = HiddenField()

    def validate_invite_code(self, field):
        expected = os.environ.get("INVITE_CODE", "")
        # No INVITE_CODE configured means sign-up is closed
        if not expected or not hmac.compare_digest(field.data.encode(), expected.encode()):
            raise ValidationError("That invite code is not valid.")

    def validate(self, extra_validators=None):
        if not super().validate(extra_validators):
            return False
        # Checked last, so only someone with a valid invite code can
        # find out whether an email is registered
        if User.query.filter_by(email=self.email.data).first():
            self.email.errors.append("An account with that email already exists.")
            return False
        return True


# ─────────────────────────────────────────
# SIGN UP
# ─────────────────────────────────────────
@auth.route("/register", methods=["GET", "POST"])
@limiter.limit(AUTH_LIMIT, methods=["POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    form = RegisterForm()
    if request.method == "GET":
        form.next.data = request.args.get("next", "")

    if form.validate_on_submit():
        user = User(email=form.email.data, display_name=form.display_name.data)
        user.set_password(form.password.data)
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError:
            # Same email registered between the check and the insert
            db.session.rollback()
            form.email.errors.append("An account with that email already exists.")
            return render_template("register.html", form=form), 400

        login_user(user)
        return redirect(_safe_next(form.next.data) or url_for("index"))

    status = 400 if request.method == "POST" else 200
    return render_template("register.html", form=form), status


# ─────────────────────────────────────────
# LOG IN
# ─────────────────────────────────────────
@auth.route("/login", methods=["GET", "POST"])
@limiter.limit(AUTH_LIMIT, methods=["POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    form = LoginForm()
    if request.method == "GET":
        form.next.data = request.args.get("next", "")

    if form.validate_on_submit():
        user = User.query.filter_by(email=form.email.data).first()
        if user:
            ok = user.check_password(form.password.data)
        else:
            check_password_hash(_DUMMY_HASH, form.password.data)
            ok = False

        if ok:
            login_user(user)
            return redirect(_safe_next(form.next.data) or url_for("index"))
        flash(LOGIN_ERROR, "error")

    status = 400 if request.method == "POST" else 200
    return render_template("login.html", form=form), status


# ─────────────────────────────────────────
# LOG OUT
# POST only, so it is covered by CSRF and a
# link on another site can't log you out
# ─────────────────────────────────────────
@auth.route("/logout", methods=["POST"])
def logout():
    logout_user()
    target = request.form.get("next") or request.args.get("next")
    return redirect(_safe_next(target) or url_for("auth.login"))
