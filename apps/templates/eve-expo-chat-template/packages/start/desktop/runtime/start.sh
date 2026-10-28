#!/usr/bin/env bash
set -euo pipefail
cd /tmp/eve
# flock prevents two startup requests from opening the same writable profile.
exec flock -n /tmp/eve-desktop.lock node daemon.mjs
