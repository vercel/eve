---
"eve": patch
---

Fix the sandbox base image so a non-interactive `bash -lc` login shell exits cleanly as `vercel-sandbox`. Ubuntu's default `.bash_logout` ran `clear_console` on exit, which wrote `TERM environment variable not set.` to stderr and, under `set -e`, turned a successful `exit 0` into exit 1 on Vercel Sandbox. `sudo` no longer warns about unresolvable sandbox hostnames, `$HOME/.local/bin` exists on `PATH` for user-scoped installs, and Node is root-owned on every architecture.
