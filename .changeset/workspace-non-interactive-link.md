---
"eve": patch
---

`eve link --non-interactive --project <name>` and `eve deploy --non-interactive --yes --project <name>` now link a multi-agent workspace from its root instead of failing with "No eve agent in this directory", so a fresh CI checkout can link and deploy every agent without a prompt.
