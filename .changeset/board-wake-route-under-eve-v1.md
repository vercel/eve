---
"@eve/board": patch
---

Serve the board's wake route at `POST /eve/v1/board/wake`, so agents behind `eve/next` or Vercel services receive wake-ups.

Named mounts register `/eve/<name>/v1/board`. Existing registrations move to the new path on the next watch change, and `POST /board/wake` keeps answering for this release.
