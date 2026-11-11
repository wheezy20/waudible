# Running WAudible as a service

WAudible runs under gunicorn on `127.0.0.1:8000`, started by `run_prod.sh` (settings in `gunicorn.conf.py`). systemd keeps it running and restarts it after a crash. The Cloudflare Tunnel forwards `waudible.eyramwilson.dev` to `http://127.0.0.1:8000`. gunicorn only listens on this machine, so nothing else on the network can reach it directly.

## Before you start

- `.env` has `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SECRET_KEY` and `INVITE_CODE` (see `.env.example`).
- `ffmpeg` and `espeak-ng` are installed, the venv exists with `requirements.txt` installed, and the Kokoro model files are in the repo root.
- `run.py` (development server) is not running, so the app and its audio worker only run once.
- Do not set `WAUDIBLE_DEBUG` or `WAUDIBLE_SECURE_COOKIES` for production. Debug is off and secure cookies are on by default.

## Try it in the foreground first

```bash
cd ~/pdf-audiobook-player
./run_prod.sh
```

In another terminal:

```bash
curl -I http://127.0.0.1:8000/login
```

You should see `HTTP/1.1 200 OK`. Stop it with Ctrl+C.

Logging in over plain `http://127.0.0.1:8000` in a browser may not work, because the session cookie is marked secure (HTTPS only). That is expected. Use the tunnel's HTTPS address, or for a quick local check start it with `WAUDIBLE_SECURE_COOKIES=0 ./run_prod.sh`.

## Install and start the service

```bash
cd ~/pdf-audiobook-player
sudo cp deploy/waudible.service /etc/systemd/system/waudible.service
sudo systemctl daemon-reload
sudo systemctl enable --now waudible
```

`enable` starts it at every boot, and `--now` starts it straight away.

## Check on it

```bash
systemctl status waudible
journalctl -u waudible -f          # live logs (Ctrl+C to stop following)
curl -I http://127.0.0.1:8000/login
```

## After changing the code

```bash
cd ~/pdf-audiobook-player
git pull                           # or however the new code arrives
source venv/bin/activate && pip install -r requirements.txt && deactivate
sudo systemctl restart waudible
```

Restarting is safe while books are being processed: progress is saved after every page, and unfinished books are queued again when the app starts.

## After editing waudible.service

```bash
sudo cp deploy/waudible.service /etc/systemd/system/waudible.service
sudo systemctl daemon-reload
sudo systemctl restart waudible
```

## Stop or remove it

```bash
sudo systemctl stop waudible       # stop until the next boot
sudo systemctl disable waudible    # don't start at boot any more
sudo rm /etc/systemd/system/waudible.service
sudo systemctl daemon-reload
```

## Notes

- The unit runs as `wheezy20` from `/home/wheezy20/pdf-audiobook-player`. If the user or folder changes, edit `User`, `Group`, `WorkingDirectory` and `ExecStart` in `waudible.service`.
- If it fails 5 times within 5 minutes (for example `SECRET_KEY` missing or ffmpeg not installed), systemd stops retrying. Fix the cause (`journalctl -u waudible` shows it), then run `sudo systemctl reset-failed waudible` and `sudo systemctl start waudible`.
- Keep `workers = 1` in `gunicorn.conf.py`. A second worker process would load a second Kokoro model and run a second audio queue.
