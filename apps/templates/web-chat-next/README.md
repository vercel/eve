# Web Chat Next template

A small Next.js app that acts as the source for eve's generated Web Chat template.

## Usage

Start the Next.js app:

```bash
pnpm --filter web-chat-next-template dev
```

The Next.js config uses `withEve()` from `eve/next`. In local
development it starts the app-local eve agent on a random available port and
rewrites same-origin eve endpoints like `/eve/v1/session` to that server, so
the client component can use `useEveAgent()` without configuring a host.

Set `EVE_BASE_URL` before starting Next.js to reuse an already-running eve
server instead of letting `withEve()` start one:

```bash
EVE_BASE_URL=http://localhost:3000 pnpm --filter web-chat-next-template dev
```

In Vercel builds, or when a linked Vercel project is detected locally,
`withEve()` writes generated `services` and `routes` to
`.vercel/output/config.json`. The Next.js app stays the default app, while
Vercel routes public eve endpoints directly to the app-local eve service before
filesystem routing.

## Scaffold Source

`packages/eve/src/setup/scaffold/create/web-template.ts` is generated from this app for
`eve init --web` and `eve channels add web`. Edit this app
first, then regenerate the scaffold module:

```bash
pnpm --filter eve generate:web-template
```

The generator recursively copies this app's Web Chat files, excluding source-only
project files and local build artifacts such as its demo agent, package metadata,
and TypeScript build state. It applies only the project-name substitutions
required by a newly created app.
