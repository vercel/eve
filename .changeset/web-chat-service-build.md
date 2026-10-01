---
"eve": patch
---

Fix generated Web Chat service builds with root-installed pnpm dependencies, and honor Vercel services configuration during project creation instead of prompting to switch to Next.js or eve. Deployment now shows Vercel build logs in the CLI and TUI and provides a command to retrieve them after a failure.
