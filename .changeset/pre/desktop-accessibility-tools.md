---
"@eve/agent-desktop": minor
---

Add the experimental `@eve/agent-desktop` extension for accessibility-based desktop automation in Linux sandboxes.

Mount the extension to launch apps, inspect accessibility trees, act on snapshot-qualified refs, and capture screenshots. Install agent-desktop in the sandbox environment's `prepare` with `installAgentDesktop`, and include `AGENT_DESKTOP_REVALIDATION_KEY` in the environment options so templates rebuild on upgrade. The package also includes desktop startup helpers, headless defaults, and cancellation errors that preserve delivery uncertainty.
