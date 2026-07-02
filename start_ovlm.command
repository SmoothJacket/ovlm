#!/bin/bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH
cd '/Users/tategebhart/ovlm'
printf '\033[1;36m── OVLM ──\033[0m\n'
npm run electron
printf '\n\033[1;31m[OVLM exited]\033[0m  Press any key to close.\n'
read -rn 1
