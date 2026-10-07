---
"eve": minor
---

**Breaking:** add the opt-in `eve-gh` preview to `eve/extensions/code`, configured with `eveGh` (off by default). Its `eve_gh` subagent works in its own Vercel Sandbox checkout created from a Git source with Sandbox-managed Git credentials and signed pushes, authorized by the calling user's Vercel account through the consumer-supplied `eveGh.auth`. There is no `connector` option. Resume fails if the sandbox no longer exists instead of recreating it.
