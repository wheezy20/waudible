# WAudible

WAudible turns PDF books into audiobooks. Upload a PDF, and it reads the book aloud page by page with Kokoro, a natural-sounding text-to-speech model that runs on the server. You listen in the browser like a music app, with a mini player that keeps playing while you browse your library and controls on the phone's lock screen.

It started as a single-user app on localhost and is now a small multi-user web app, served at `waudible.eyramwilson.dev` through a Cloudflare Tunnel. Sign-up needs an invite code.

**A personal project run from a laptop.** The server is my own laptop, so WAudible is only available while that machine is switched on, online and running the service. Expect downtime, and don't rely on it for anything important.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![Flask](https://img.shields.io/badge/Flask-3.1-orange)
![Kokoro](https://img.shields.io/badge/TTS-Kokoro_ONNX-green)
![Postgres](https://img.shields.io/badge/DB-Neon_Postgres-00E599)

## Features

- **Accounts with an invite code.** Sign up with email and password; sign-up is closed unless you know the invite code.
- **Private libraries.** Every user sees only their own books, covers, audio and listening progress.
- **MP3 audio, made in the background.** One worker turns pages into MP3 (mono, 64 kbps) in upload order. You can start listening as soon as the first pages are ready, and a page that isn't ready yet is made on demand. Pages with nothing to read become a few seconds of silence, and one bad page never stops a book.
- **Lock-screen controls.** Title, chapter and cover show on the phone's lock screen and notification, with play, pause, previous and next page and seeking. The next page is buffered ahead of time so playback continues with the screen off.
- **Persistent mini player.** Audio keeps playing while you move between Home and Library. The player collapses to a mini player above the bottom bar and expands again with a tap; the Back button closes the player or any open sheet first.
- **Genre shelves.** Books sit on shelves (Self Help, Academic, Christian, or your own), with filter chips, cover art (yours or generated initials) and a Continue listening row.
- **Contents drawer.** Jump to any chapter from the PDF's table of contents, with dots showing which pages are ready.
- **Player controls.** Speed from 0.75x to 2x (changed in the browser, so no new audio is needed), six voices, 15 second skips, jump to page, sleep timer, and the page text.
- **Picks up where you left off**, on any device.
- **Works on phones, tablets and desktop.**

## Stack

| Part | Tool |
|---|---|
| Web app | Flask 3, Jinja templates |
| Frontend | htmx (self-hosted) and plain JavaScript; JavaScript is required |
| Accounts | Flask-Login, Flask-WTF (forms and CSRF), Flask-Limiter |
| Database | Neon Postgres through Flask-SQLAlchemy and psycopg 3 |
| Text-to-speech | Kokoro ONNX (with espeak-ng) |
| PDF text and contents | PyMuPDF |
| Audio encoding | ffmpeg (MP3) |
| Production server | gunicorn under systemd |
| Public access | Cloudflare Tunnel |

Uploaded PDFs, covers and audio are files on the server's disk (`data/`, not in git). Users, books and progress live in Postgres.

## Setting it up from scratch

These steps are for Ubuntu (tested on 24.04) with Python 3.10 or newer.

### 1. System packages

```bash
sudo apt install python3-venv espeak-ng ffmpeg -y
```

ffmpeg must include the MP3 encoder (libmp3lame), which the Ubuntu package does. The app checks this when it starts.

### 2. Code and Python packages

```bash
git clone https://github.com/wheezy20/waudible.git
cd waudible
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Kokoro model files

Download both into the repo root (about 340 MB in total; they are gitignored):

```bash
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

### 4. Database and settings

Create a Postgres database on [Neon](https://neon.tech) (any Postgres works). Then copy the example settings and fill them in:

```bash
cp .env.example .env
```

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Pooled connection string (the Neon hostname contains `-pooler`). Used by the running app. |
| `DATABASE_URL_UNPOOLED` | Direct connection string. Used only to create tables. |
| `SECRET_KEY` | Signs login sessions. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`. The app won't start without it. |
| `INVITE_CODE` | The code people must enter to sign up. Sign-up is closed while it is empty. |
| `NEON_BRANCH` | Neon branch name, for reference only. |

`.env` is gitignored. Never commit it. With the Neon CLI, `neon env pull` can write the connection strings for you.

### 5. Create the tables

```bash
python init_db.py
```

This creates the `users`, `books` and `progress` tables over the direct connection. It is safe to run again.

### 6. Run it locally

```bash
./run.sh
```

Open `http://localhost:5000`, sign up with your invite code, and upload a PDF. `run.sh` turns secure-only cookies off because localhost is plain http. For the Flask debugger and reloader, use `WAUDIBLE_DEBUG=1 ./run.sh` (local development only).

Startup takes a few seconds while the Kokoro model loads.

## Running it in production

```bash
./run_prod.sh
```

This starts gunicorn with one worker process and four threads on `127.0.0.1:8000` only (settings in `gunicorn.conf.py`). Keep it at one worker process: the Kokoro model and the audio queue must exist only once. Debug is always off, and cookies are secure-only, so log in through HTTPS.

To keep it running and start it at boot, install the systemd unit in `deploy/`. The full steps (try it in the foreground, install, check the logs, update, remove) are in [`deploy/README.md`](deploy/README.md). In short:

```bash
sudo cp deploy/waudible.service /etc/systemd/system/waudible.service
sudo systemctl daemon-reload
sudo systemctl enable --now waudible
journalctl -u waudible -f
```

Edit `User`, `Group`, `WorkingDirectory` and `ExecStart` in the unit if your user or folder differs.

### Public access with Cloudflare Tunnel

gunicorn never listens on the network. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`) runs on the same machine, connects out to Cloudflare, and forwards your hostname to `http://127.0.0.1:8000`, so no router ports are opened. Roughly:

```bash
cloudflared tunnel login
cloudflared tunnel create waudible
cloudflared tunnel route dns waudible your.hostname.example
# ~/.cloudflared/config.yml: the tunnel id, its credentials file, and an
# ingress rule sending your.hostname.example to http://127.0.0.1:8000
sudo cloudflared service install
```

The tunnel's credentials and certificate stay in `~/.cloudflared`, outside the repo (they are also gitignored in case they are ever copied in).

## Tests

The test suites cover sign-up and login, per-user privacy, uploads, the audio worker, the production settings, request logging, and the player in headless Chrome (navigation, the Back button and the lock-screen controls). They write to the database, so they only run on a temporary Neon branch and refuse to start against production. Kokoro is replaced by a fake, so they are quick and need no model files. See [`tests/README.md`](tests/README.md), then:

```bash
./run_tests.sh
```

## Security

WAudible is a hobby project for a small group of invited people. Here is what it does and doesn't do.

**In place**

- **Passwords** are stored only as salted scrypt hashes (Werkzeug), and must be at least 8 characters. Login takes the same time whether or not the email exists.
- **Invite-only sign-up**: a single shared invite code from the server's settings is required.
- **CSRF protection** on every form and every request that changes data (Flask-WTF).
- **Rate limits** per client address: login and sign-up 10 per minute, uploads 20 per hour.
- **Per-user access checks**: every page, file and audio request needs a login, and books are looked up by id and owner, so another user's book returns 404. Files are stored under random names, not titles.
- **Upload checks**: PDFs up to 100 MB that must really be PDFs; covers must really be JPG, PNG or WebP under 5 MB; at most 20 books per user.
- **Cookies** are HttpOnly, SameSite=Lax and Secure (HTTPS only).
- **Headers**: Content-Security-Policy, X-Frame-Options DENY, X-Content-Type-Options nosniff and a strict Referrer-Policy.
- **Network**: the app listens on 127.0.0.1 only and is reached through Cloudflare Tunnel, which provides HTTPS.
- **Debug mode** is off in production, and secrets live in `.env`, which is not in git.

**Not in place**

- No email verification, password reset, or two-factor login. A forgotten password has to be reset by the server owner.
- No self-service account deletion.
- Rate limits are kept in memory, so they reset when the app restarts, and there is no account lockout beyond them.
- One invite code is shared by everyone; there are no per-person or expiring invites.
- Uploaded books, covers and audio are stored unencrypted on the laptop's disk, and the server owner can read them. There are no backups of these files.
- The Content-Security-Policy still allows inline scripts and styles, and pages load fonts from Google Fonts.
- Uploaded PDFs are checked for type and size but are not virus scanned before PyMuPDF reads them.
- The app sends no HSTS header itself.
- Nobody has audited the code. Please don't upload anything sensitive.

If you find a security problem, please contact me privately rather than opening a public issue.

## Project layout

```
app/
  main.py          Flask config, security headers and routes
  auth.py          Sign-up, login and logout
  models.py        User, Book and Progress tables
  worker.py        The background audio worker, its queue and watchdog
  tts_engine.py    Kokoro, page audio, silence for empty pages
  audio_codec.py   ffmpeg MP3 encoding
  pdf_reader.py    Page text, metadata and contents
  artwork.py       Square cover art for the lock screen
  limiter.py       Rate limits
  storage.py       Where each book's files live
  request_log.py   Slow request and database connect error logging
  templates/       Page shell, player, cards, login and error pages
  static/          CSS, htmx, player and page scripts
deploy/            systemd unit and install steps
tests/             Test suites (see tests/README.md)
run_tests.sh       Runs every test suite against a temporary Neon branch
init_db.py         Creates the database tables
run.sh             Local development server
run_prod.sh        Production server (gunicorn)
gunicorn.conf.py   gunicorn settings
data/              Books, covers and audio (gitignored)
```

ARCHITECTURE.md describes the design in more detail, PLAN.md the roadmap, and JOURNAL.md the history.

The hosted version described here is on `main`. New work happens on `online-version` first and is merged in when it's ready. The original local, single-user version is still in the history (the first commit, `333a47e`).

## Author

**Eyram** ([@wheezy20](https://github.com/wheezy20)). Built as a personal project and a way to learn Python and web development.
