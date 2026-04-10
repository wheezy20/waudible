# 🎧 WAudible

A locally hosted AI audiobook player that reads your PDF books aloud — 
like Audible or Spotify, but running entirely on your own machine.

Built with Python, Flask, and Kokoro AI text-to-speech.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![Flask](https://img.shields.io/badge/Flask-3.1-orange)
![Kokoro](https://img.shields.io/badge/TTS-Kokoro_ONNX-green)
![Platform](https://img.shields.io/badge/Platform-Ubuntu_22.04-E95420)

---

## Features

- 📚 Upload PDF books and have them read aloud in a natural AI voice
- 🎨 Genre shelves — organise books by Self Help, Academic, Christian, etc.
- 🖼 Book cover art — upload your own or auto-generated initials
- ⚡ Background audio processing — pages convert while you listen
- 📖 Table of contents sidebar — jump to any chapter instantly
- ▶ Full player controls — play/pause, speed (0.75× to 2.0×), voice selection
- 💾 Auto-resume — picks up exactly where you left off
- 🖥 Runs as a desktop app on Ubuntu

---

## Tech Stack

| Layer | Tool |
|---|---|
| Backend | Flask (Python) |
| Text-to-Speech | Kokoro ONNX |
| PDF Extraction | PyMuPDF |
| Frontend | HTML + CSS + HTMX |
| Audio | HTML5 Audio API |
| Storage | Local filesystem |

---

## Security Note

WAudible is designed as a **personal, offline leisure app**.
It runs only on `localhost` and is never exposed to the internet.
No login system or encryption is included by design.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/wheezy20/waudible.git
cd waudible
```

### 2. Create and activate virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install system dependency

```bash
sudo apt install espeak-ng -y
```

### 4. Install Python packages

```bash
pip install -r requirements.txt
```

### 5. Download Kokoro AI model files

```bash
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

### 6. Run the app

```bash
./run.sh
```

Then open your browser at `http://localhost:5000`

---

## Ubuntu Desktop App (Optional)

To add WAudible to your Ubuntu apps list and desktop:

```bash
# Copy icon
mkdir -p ~/.local/share/icons
cp assets/waudible.png ~/.local/share/icons/waudible.png

# Install desktop entry
cp waudible.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/

# Add to desktop
cp waudible.desktop ~/Desktop/
chmod +x ~/Desktop/waudible.desktop
```

---

## Project Structure
waudible/
├── app/
│   ├── main.py            # Flask routes
│   ├── tts_engine.py      # Kokoro TTS + background processing
│   ├── pdf_reader.py      # PDF text + TOC extraction
│   ├── session_manager.py # Reading progress
│   ├── templates/         # HTML pages
│   └── static/css/        # Styling
├── data/                  # Books, audio, sessions (gitignored)
├── assets/                # App icon
├── requirements.txt
├── run.py
├── run.sh
└── launch.sh

---

## Author

**Eyram** — [@wheezy20](https://github.com/wheezy20)

*Built as a personal productivity tool and Python learning project.*