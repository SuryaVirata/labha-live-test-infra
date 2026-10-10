#!/bin/bash
for p in 159667 159668 160495; do
  echo "PID=$p"
  tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null
  echo
  readlink /proc/$p/cwd 2>/dev/null
  echo "---"
done
