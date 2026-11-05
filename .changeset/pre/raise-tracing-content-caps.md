---
"@vercel/agent-runs": patch
---

Raise the tracing content caps from 32 KiB per attribute and 64 KiB per checkpointed operation to 250 KiB and 512 KiB, so prompts up to 250 KiB are captured in full instead of truncated.
