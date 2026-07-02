#!/bin/bash
# OVLM Backend — double-clickable or launched by OVLM.app
cd "$(dirname "$0")"
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH

printf '\033[1;32m── OVLM Backend ──\033[0m\n'

# Prefer project venv; fall back to system python3
PYTHON3="nuc/.venv/bin/python3"
[[ -x "$PYTHON3" ]] || PYTHON3="python3"

"$PYTHON3" nuc/main.py
printf '\n\033[1;31m[backend exited]\033[0m  Press any key to close.\n'
read -rn 1
