#!/usr/bin/env bash
# OVLM Pi installer
# Run once after copying the pi/ folder to the Pi:
#   chmod +x install.sh && ./install.sh
#
# What it does:
#   1. Installs system packages picamera2 needs
#   2. Creates a Python virtualenv at ~/ovlm-venv
#   3. Installs Python dependencies into the venv
#   4. Installs and enables the systemd service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/ovlm-venv"
SERVICE_NAME="ovlm"
SERVICE_FILE="$SCRIPT_DIR/ovlm.service"

echo "=== OVLM installer ==="
echo "Project dir : $SCRIPT_DIR"
echo "Virtualenv  : $VENV"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/4] Installing system packages …"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    python3-picamera2 \
    python3-venv \
    python3-pip \
    libportaudio2 \
    portaudio19-dev \
    libopencv-dev \
    python3-opencv

# ── 2. Virtualenv ─────────────────────────────────────────────────────────────
echo ""
echo "[2/4] Creating virtualenv at $VENV …"
# --system-site-packages lets the venv see picamera2 (installed system-wide)
python3 -m venv --system-site-packages "$VENV"
"$VENV/bin/pip" install --upgrade pip --quiet

# ── 3. Python dependencies ────────────────────────────────────────────────────
echo ""
echo "[3/4] Installing Python dependencies …"
"$VENV/bin/pip" install \
    opencv-python-headless \
    numpy \
    websockets \
    pyaudio \
    --quiet

echo "  Done. Installed packages:"
"$VENV/bin/pip" list --format=columns | grep -E "opencv|numpy|websockets|pyaudio|picamera"

# ── 4. Systemd service ────────────────────────────────────────────────────────
echo ""
echo "[4/4] Installing systemd service …"

# Patch the WorkingDirectory and ExecStart paths to match actual location
TMP_SERVICE="/tmp/${SERVICE_NAME}.service"
sed \
    -e "s|WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|" \
    -e "s|ExecStart=.*|ExecStart=$VENV/bin/python main.py|" \
    -e "s|User=pi|User=$USER|" \
    -e "s|Group=pi|Group=$USER|" \
    "$SERVICE_FILE" > "$TMP_SERVICE"

sudo cp "$TMP_SERVICE" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Useful commands:"
echo "  sudo systemctl start $SERVICE_NAME     — start now"
echo "  sudo systemctl stop $SERVICE_NAME      — stop"
echo "  sudo systemctl restart $SERVICE_NAME   — restart"
echo "  sudo systemctl status $SERVICE_NAME    — check status"
echo "  journalctl -u $SERVICE_NAME -f         — live logs"
echo ""
echo "IMPORTANT: Run calibration before starting the service:"
echo "  cd $SCRIPT_DIR"
echo "  $VENV/bin/python calibrate.py --live"
echo ""
echo "Network setup (sets hostname to ovlm.local, configures WiFi):"
echo "  ./setup_network.sh --ssid YOUR_SSID --pass YOUR_PASS"
echo "  Then connect the browser to: ws://ovlm.local:8765"
echo ""

read -rp "Start the service now? [y/N] " answer
if [[ "${answer,,}" == "y" ]]; then
    sudo systemctl start "$SERVICE_NAME"
    echo "Service started. Tailing logs (Ctrl+C to exit):"
    sleep 1
    journalctl -u "$SERVICE_NAME" -f --no-pager
fi
