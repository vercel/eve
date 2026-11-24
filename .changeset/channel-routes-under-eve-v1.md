---
"eve": minor
"@eve/board": minor
---

Export `publicRoutePath` from `eve/channels`, reserve eve's own `/eve/v1/` protocol namespaces at compile time, warn on unreachable channel routes in Vercel service builds, and move `@eve/board`'s default wake route to `POST /eve/v1/board/wake` with a `route` option.

`@eve/board` continues serving `POST /board/wake` for one release so existing 0.1.0 standalone registrations keep waking until their next watch update rewrites the registration path.
