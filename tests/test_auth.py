"""Sign-up with the invite code, login, logout, safe redirects and CSRF."""
import re
import helpers
from helpers import email, form_token, meta_token

from app.main import app
from app.auth import LOGIN_ERROR
from app.limiter import limiter
from app.models import db, User

limiter.enabled = False          # rate limits have their own checks in test_prod.py
T = helpers.Results("auth")
helpers.show_database()
PW = helpers.password()
EMAIL = email("auth1")


def register(c, **over):
    data = {"display_name": "Auth Tester", "email": EMAIL, "password": PW, "confirm": PW,
            "invite_code": helpers.INVITE_CODE, **over}
    data["csrf_token"] = form_token(c, "/register")
    return c.post("/register", data=data)


def login(c, addr, pw, next_=""):
    t = form_token(c, "/login" + (f"?next={next_}" if next_ else ""))
    return c.post("/login", data={"email": addr, "password": pw, "next": next_, "csrf_token": t})


def logout(c, next_=""):
    return c.post("/logout", data={"csrf_token": meta_token(c), "next": next_})


try:
    c = helpers.HttpsClient(app)

    T.section("Sign-up")
    r = register(c, email="  ZZ_Test_Auth1@Example.COM ")
    T.check("sign-up with the invite code logs you in", r.status_code == 302 and r.location == "/", f"{r.status_code} {r.location}")
    home = c.get("/").get_data(as_text=True)
    T.check("header shows the display name and Log out", "Auth Tester" in home and "Log out" in home)
    with app.app_context():
        u = User.query.filter(User.email.like(f"{helpers.PREFIX}auth%")).one()
        T.check("email trimmed and lowercased", u.email == EMAIL, u.email)
        T.check("password stored as a scrypt hash, never as text", u.password_hash.startswith("scrypt:") and PW not in u.password_hash)
    logout(c)

    r = register(c, email=EMAIL.upper())
    T.check("duplicate email rejected", r.status_code == 400 and "already exists" in r.get_data(as_text=True), r.status_code)
    r = register(c, email=email("auth2"), invite_code="wrong-code")
    T.check("wrong invite code rejected", r.status_code == 400 and "invite code is not valid" in r.get_data(as_text=True), r.status_code)
    body = register(c, email=EMAIL, invite_code="wrong-code").get_data(as_text=True)
    T.check("a wrong invite code doesn't reveal that an email exists", "invite code is not valid" in body and "already exists" not in body)
    r = register(c, email=email("auth3"), password="short7!", confirm="short7!")
    T.check("7-character password rejected", r.status_code == 400 and "at least 8 characters" in r.get_data(as_text=True), r.status_code)
    r = register(c, email=email("auth4"), confirm=PW + "x")
    T.check("mismatched confirmation rejected", r.status_code == 400 and "do not match" in r.get_data(as_text=True), r.status_code)
    r = register(c, email="not-an-email")
    T.check("invalid email rejected", r.status_code == 400 and "valid email" in r.get_data(as_text=True), r.status_code)
    with app.app_context():
        n = User.query.filter(User.email.like(f"{helpers.PREFIX}auth%")).count()
    T.check("rejected sign-ups created no users", n == 1, f"{n} user(s)")

    T.section("Login and logout")
    r = login(c, "  ZZ_TEST_AUTH1@example.com ", PW)
    T.check("login with any case and spaces", r.status_code == 302 and r.location == "/", f"{r.status_code} {r.location}")
    T.check("a logged-in user visiting /login goes home", c.get("/login").status_code == 302)
    r = logout(c)
    T.check("logout goes to the login page", r.status_code == 302 and r.location == "/login", f"{r.status_code} {r.location}")
    r = c.get("/")
    T.check("signed out after logout", r.status_code == 302 and r.location.startswith("/login"), r.location)

    r1, r2 = login(c, EMAIL, "wrong-password-123"), login(c, email("nobody"), "wrong-password-123")
    b1, b2 = r1.get_data(as_text=True), r2.get_data(as_text=True)
    T.check("wrong password rejected", r1.status_code == 400 and LOGIN_ERROR in b1, r1.status_code)
    T.check("unknown email rejected with the same message", r2.status_code == 400 and LOGIN_ERROR in b2 and "exist" not in b2)

    T.section("Redirects after login and logout")
    r = login(c, EMAIL, PW, next_="/library?x=1")
    T.check("next to one of our pages is kept", r.location == "/library?x=1", r.location)
    r = logout(c, next_="/register")
    T.check("logout next to one of our pages is kept", r.location == "/register", r.location)
    for bad in ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example",
                "/\t/evil.example", "javascript:alert(1)", "http:/evil.example", " //evil.example"]:
        r_in = login(c, EMAIL, PW, next_=bad)
        r_out = logout(c, next_=bad)
        T.check(f"outside next {bad!r} ignored", (r_in.status_code, r_in.location, r_out.location) == (302, "/", "/login"),
                f"{r_in.location} / {r_out.location}")

    T.section("CSRF")
    anon = helpers.HttpsClient(app)
    T.check("login without a token rejected", anon.post("/login", data={"email": EMAIL, "password": PW}).status_code == 400)
    login(c, EMAIL, PW)
    T.check("logout without a token rejected", c.post("/logout").status_code == 400)
    T.check("upload without a token rejected", c.post("/upload", data={}).status_code == 400)
    T.check("save_progress without a token rejected", c.post("/save_progress", json={"book_id": 1, "page": 0}).status_code == 400)
    T.check("delete without a token rejected", c.post("/delete/1").status_code == 400)
    home = c.get("/").get_data(as_text=True)
    T.check("page shell carries the token (meta tag and forms)", re.search(r'name="csrf-token" content="[^"]+"', home)
            and home.count('name="csrf_token"') >= 3)
    other = helpers.HttpsClient(app)
    login(other, EMAIL, PW)
    r = other.post("/save_progress", json={"book_id": 1, "page": 0}, headers={"X-CSRFToken": meta_token(c)})
    T.check("another session's token is not accepted", r.status_code == 400, r.status_code)
finally:
    n, _ = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s)")
T.finish()
