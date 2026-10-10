#!/bin/bash
source ~/.nvm/nvm.sh
nvm use 22 >/dev/null 2>&1
cd /mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-dashboard
exec npm run dev -- --host
