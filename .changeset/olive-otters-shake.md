---
"eve": patch
---

Make every non-interactive `eve add` end on a terminal NDJSON event. A resumed setup (`--skip-install`) and a registry package install previously finished silently, so callers had no way to confirm the outcome or learn that a deploy was still required.
