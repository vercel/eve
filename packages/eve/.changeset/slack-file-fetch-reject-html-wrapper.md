---
"eve": patch
---

Reject Slack's browser sign-in HTML when the private file fetch returns `text/html` (or an HTML body with no `Content-Type`): the Connect/Slack connector then throws an actionable error naming the likely missing `files:read` bot scope (and to reinstall the app after adding it), instead of staging the login page as the attachment and surfacing it downstream as a vision/auth mystery. Happy-path file downloads (binary or non-HTML responses) are unchanged.
