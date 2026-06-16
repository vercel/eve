# Next.js with Eve demo

To run locally, call

```
pnpm --filter framework-next dev
```

The Next.js config uses `withEve()` from `eve/next`. In local
development it starts Eve on a random available port and rewrites same-origin
Eve endpoints like `/eve/v1/session` to that server.

Set `EVE_BASE_URL` before starting Next.js to reuse an already-running Eve
server instead of letting `withEve()` start one.

When a linked Vercel project is detected, `withEve()` writes generated
`experimentalServices` to `.vercel/output/config.json` for Next.js at `/` and
Eve behind the private `/_eve_internal/eve` service prefix. Next.js rewrites
the public Eve endpoints to that private service so the Eve index route is not
exposed at the site root.

For non-Vercel production hosts, set `EVE_NEXT_PRODUCTION_ORIGIN` to the public
origin that serves the Eve service namespace before building the Next.js app.
For local production builds, `withEve()` uses `http://127.0.0.1:4274` as the
stable Eve origin. Set `EVE_NEXT_PRODUCTION_PORT` before `next build` and
`next start` to choose a different local port.
