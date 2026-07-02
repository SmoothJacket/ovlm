#!/bin/bash
# OVLM Frontend — double-clickable or launched by OVLM.app
cd "$(dirname "$0")"
printf '\033[1;34m── OVLM Frontend ──\033[0m\n'
npm run dev
printf '\n\033[1;31m[frontend exited]\033[0m  Press any key to close.\n'
read -rn 1
