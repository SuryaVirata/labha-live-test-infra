#!/bin/bash
set -e
echo "Killing existing next dev processes for labha-storefront..."
for p in 159667 159668 160495; do
  kill -9 "$p" 2>/dev/null || true
done
sleep 1
cd /mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-storefront
rm -f /tmp/storefront-dev.log
nohup npm run dev > /tmp/storefront-dev.log 2>&1 &
disown
echo "Started. PID of shell: $!"
