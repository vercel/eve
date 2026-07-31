---
"eve": patch
---

The `/traces` viewer now follows your terminal's colors instead of forcing a hardcoded black/grey truecolor palette. It probes the terminal's default background (OSC 11) and derives its card surfaces from your own theme — subtly elevated bands on dark and light backgrounds alike, with red bands for failures, and card titles that invert to black on light backgrounds so they stay legible. Terminals that don't answer the probe get a clean gutter-rail rendering drawn entirely with the shared TUI theme.
