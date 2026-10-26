---
"eve": patch
---

Session callbacks now reach only public addresses. The eve channel rejects callback URLs with a non-HTTP scheme or a loopback host, and callback delivery refuses to connect when a callback hostname resolves to a loopback, private, link-local, or reserved address. Loopback callbacks still work on local development servers (`eve dev` and `vercel dev`).
