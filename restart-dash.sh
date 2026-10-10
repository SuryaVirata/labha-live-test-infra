#!/bin/bash
source ~/.nvm/nvm.sh >/dev/null 2>&1
nvm use 22 >/dev/null 2>&1
cd /mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-dashboard
nohup npm run dev -- --host >/tmp/vite-5173.log 2>&1 &
disown
echo "vite restarted"
