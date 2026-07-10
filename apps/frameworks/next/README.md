# Next.js with eve demo

To run locally, call

```
pnpm --filter framework-next dev
```

The Next.js config uses `withEve()` from `eve/next`. In local
development it starts eve on a random available port and rewrites same-origin
eve endpoints like `/eve/v1/session` to that server.

Set `EVE_BASE_URL` before starting Next.js to reuse an already-running eve
server instead of letting `withEve()` start one.

When a linked Vercel project is detected, `withEve()` writes generated
`services` and `routes` to `.vercel/output/config.json`. The Next.js app stays
the default app, while Vercel routes public eve endpoints directly to the eve
service before filesystem routing.

For non-Vercel production hosts, set `EVE_NEXT_PRODUCTION_ORIGIN` to the public
origin that serves the eve service namespace before building the Next.js app.
For local production builds, `withEve()` uses `http://127.0.0.1:4274` as the
stable eve origin. Set `EVE_NEXT_PRODUCTION_PORT` before `next build` and
`next start` to choose a different local port.
