#!/bin/bash
# OVLM — one-shot setup for macOS (Intel or Apple Silicon)
set -e
cd "$(dirname "$0")"

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}▶ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
abort() { echo -e "${RED}✗ $*${NC}"; exit 1; }

# ── Homebrew ──────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  abort "Homebrew not found. Install it first: https://brew.sh"
fi
BREW_PREFIX="$(brew --prefix)"

# ── portaudio (needed by pyaudio) ─────────────────────────────────────────────
if ! brew list portaudio &>/dev/null; then
  info "Installing portaudio via Homebrew…"
  brew install portaudio
else
  info "portaudio already installed"
fi

# ── Python ────────────────────────────────────────────────────────────────────
# Use Python 3.11+ from Homebrew if available; fall back to whatever python3 exists.
PYTHON3=""
for candidate in \
    "$BREW_PREFIX/bin/python3.12" \
    "$BREW_PREFIX/bin/python3.11" \
    "$BREW_PREFIX/bin/python3" \
    "/usr/bin/python3"; do
  if [[ -x "$candidate" ]]; then
    PYTHON3="$candidate"
    break
  fi
done
[[ -z "$PYTHON3" ]] && abort "python3 not found. Install via: brew install python"
info "Using Python: $PYTHON3 ($(${PYTHON3} --version))"

# ── Virtual environment ───────────────────────────────────────────────────────
VENV="nuc/.venv"
if [[ ! -d "$VENV" ]]; then
  info "Creating Python virtual environment at $VENV …"
  "$PYTHON3" -m venv "$VENV"
fi
PIP="$VENV/bin/pip"
info "Upgrading pip…"
"$PIP" install --quiet --upgrade pip

# ── Python packages ───────────────────────────────────────────────────────────
info "Installing Python dependencies…"
# pyaudio needs to know where portaudio headers are
PORTAUDIO_INC="$BREW_PREFIX/include"
PORTAUDIO_LIB="$BREW_PREFIX/lib"
CFLAGS="-I$PORTAUDIO_INC" LDFLAGS="-L$PORTAUDIO_LIB" \
  "$PIP" install --quiet -r nuc/requirements.txt

# ── Node / npm ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  abort "Node.js not found. Install via: brew install node"
fi
info "Installing Node dependencies…"
npm install --silent

# ── Permissions ───────────────────────────────────────────────────────────────
info "Making launch scripts executable…"
chmod +x start_ovlm.command start_backend.command start_frontend.command 2>/dev/null || true

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✓ OVLM is ready.${NC}"
echo ""
echo "  Launch options:"
echo "    Double-click  start_ovlm.command      — full app (Electron)"
echo "    Double-click  start_backend.command   — backend only"
echo "    Double-click  start_frontend.command  — frontend only (npm run dev)"
echo ""
echo "  Or from Terminal:"
echo "    npm run electron                       — full Electron app"
echo "    nuc/.venv/bin/python3 nuc/main.py     — backend only"
echo "    npm run dev                            — Vite dev server"
echo ""
warn "First run: calibrate cameras before tracking (Calibration tab in the UI)."
