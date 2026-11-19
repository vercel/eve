---
"@eve/takeover": minor
"@eve/agent-browser": minor
"@eve/agent-desktop": minor
---

Add the experimental `@eve/takeover` extension, which lets a person take over the agent's sandboxed browser or desktop to sign in, enter a code, or solve a CAPTCHA, then hand control back.
Configure it once with `defineTakeover` from `@eve/takeover/core` and pass the value to `@eve/takeover`, which serves the requester-only viewer, and to `@eve/agent-browser` or `@eve/agent-desktop`, which then add a `takeover` tool. The tool parks the turn on eve's interactive sign-in, streams the screen through a token-gated proxy in the sandbox, and resumes when the person presses Done. The browser streams agent-browser's screencast; the desktop streams VNC through `x11vnc`. Port exposure defaults to Vercel Sandbox routes.
