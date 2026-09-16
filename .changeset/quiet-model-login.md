---
"eve": patch
---

Open the TUI directly after init, connect models through `/login` without requiring a Vercel project, and store local credentials securely. Add direct OpenAI and Anthropic model helpers, apply model selections immediately, and simplify menus and `/add` to get to chat sooner. Vercel CLI installation and login now run during deployment instead of separate `/vc:install` and `/vc:login` commands.
