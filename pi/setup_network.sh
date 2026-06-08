#!/usr/bin/env bash
# OVLM network setup
# Sets the Pi hostname so the dashboard can reach it at ovlm.local,
# configures WiFi via NetworkManager (Pi OS Bookworm / Pi 5 default),
# and ensures avahi-daemon (mDNS) is installed and running.
#
# Usage:
#   chmod +x setup_network.sh
#   ./setup_network.sh [--hostname NAME] [--ssid SSID] [--pass PASSWORD]
#
# Flags (all optional — script prompts for missing WiFi creds):
#   --hostname NAME   mDNS hostname without .local  (default: ovlm)
#   --ssid    SSID    WiFi network name
#   --pass    PASS    WiFi password
#   --no-wifi         Skip WiFi setup (useful when already on Ethernet)
#
# After running: connect to ws://ovlm.local:8765 from the browser

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
NEW_HOSTNAME="ovlm"
WIFI_SSID=""
WIFI_PASS=""
SKIP_WIFI=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) NEW_HOSTNAME="$2"; shift 2 ;;
    --ssid)     WIFI_SSID="$2";    shift 2 ;;
    --pass)     WIFI_PASS="$2";    shift 2 ;;
    --no-wifi)  SKIP_WIFI=true;    shift   ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo "=== OVLM network setup ==="
echo ""

# ── 1. Hostname ───────────────────────────────────────────────────────────────
echo "[1/3] Setting hostname to '$NEW_HOSTNAME' …"
OLD_HOSTNAME="$(hostname)"

sudo hostnamectl set-hostname "$NEW_HOSTNAME"

# Update /etc/hosts so localhost still resolves under new name
sudo sed -i "s/\b${OLD_HOSTNAME}\b/${NEW_HOSTNAME}/g" /etc/hosts

echo "  Hostname: $OLD_HOSTNAME → $NEW_HOSTNAME"
echo "  (takes effect immediately for new connections)"

# ── 2. avahi-daemon (mDNS — provides .local resolution) ──────────────────────
echo ""
echo "[2/3] Ensuring avahi-daemon is installed and running …"

if ! dpkg -s avahi-daemon &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends avahi-daemon libnss-mdns
fi

sudo systemctl enable --now avahi-daemon
echo "  avahi-daemon: $(systemctl is-active avahi-daemon)"
echo "  Reachable at: ${NEW_HOSTNAME}.local"

# ── 3. WiFi (NetworkManager — Bookworm default) ───────────────────────────────
echo ""
echo "[3/3] WiFi setup …"

if $SKIP_WIFI; then
  echo "  Skipped (--no-wifi)."
else
  # Prompt for missing credentials
  if [[ -z "$WIFI_SSID" ]]; then
    read -rp "  WiFi SSID (blank to skip): " WIFI_SSID
  fi

  if [[ -z "$WIFI_SSID" ]]; then
    echo "  No SSID provided — skipping WiFi setup."
  else
    if [[ -z "$WIFI_PASS" ]]; then
      read -rsp "  WiFi password: " WIFI_PASS
      echo ""
    fi

    # Check if NetworkManager is running (Pi OS Bookworm / Pi 5)
    if systemctl is-active --quiet NetworkManager; then
      echo "  Configuring via NetworkManager …"

      # Remove any existing profile for this SSID to avoid duplicates
      nmcli connection delete "$WIFI_SSID" 2>/dev/null || true

      nmcli device wifi connect "$WIFI_SSID" password "$WIFI_PASS"
      echo "  Connected to '$WIFI_SSID'."

    # Fallback: wpa_supplicant (Pi OS Bullseye and older)
    elif systemctl is-active --quiet wpa_supplicant; then
      echo "  Configuring via wpa_supplicant …"
      WPA_CONF="/etc/wpa_supplicant/wpa_supplicant.conf"

      BLOCK="$(wpa_passphrase "$WIFI_SSID" "$WIFI_PASS")"

      # Append if SSID not already present; otherwise replace
      if sudo grep -q "\"${WIFI_SSID}\"" "$WPA_CONF" 2>/dev/null; then
        echo "  SSID already in wpa_supplicant.conf — updating …"
        # Remove old block for this SSID (simple sed; won't handle nested braces)
        sudo sed -i "/network={/,/}/{ /ssid=\"${WIFI_SSID}\"/,/}/d }" "$WPA_CONF"
      fi

      echo "$BLOCK" | sudo tee -a "$WPA_CONF" >/dev/null
      sudo wpa_cli -i wlan0 reconfigure >/dev/null
      echo "  WiFi reconfigured."

    else
      echo "  WARNING: Neither NetworkManager nor wpa_supplicant detected."
      echo "  Configure WiFi manually and re-run without --ssid."
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Network setup complete ==="
echo ""
echo "  Hostname  : ${NEW_HOSTNAME}.local"
echo "  WS URL    : ws://${NEW_HOSTNAME}.local:8765"
echo ""
echo "  Test mDNS from your laptop:"
echo "    ping ${NEW_HOSTNAME}.local"
echo ""
echo "  If ping fails on macOS/Linux, install nss-mdns / avahi-utils."
echo "  On Windows, install Bonjour (bundled with iTunes / Apple devices)."
echo ""
echo "  Update the browser dashboard host to: ws://${NEW_HOSTNAME}.local:8765"
echo "  (Settings or the host field in the Capture panel)"
