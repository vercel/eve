---
"eve": patch
---

When a registry item's setup needs a logged-in Vercel CLI, `/add` in `eve dev` now offers to run `vercel login` and then finishes setup without reinstalling the item. Items whose setup fails after their files are installed now show as "setup not finished" with the reason, instead of "Couldn't add". `eve add --non-interactive` reports a `vercel login` prerequisite (exit 2) instead of a raw `vercel connect` failure. eve now detects a logged-out Vercel CLI from `vercel whoami --format json`, so newer CLIs that print only "Logged out." are no longer misreported as a transient error. The self-modification agent no longer describes an item as added before its setup panel has run.
