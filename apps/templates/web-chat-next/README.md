# Web Chat Next template

A small Next.js app that acts as the source for Eve's generated Web Chat template.

## Usage

Start the Next.js app:

```bash
pnpm --filter web-chat-next-template dev
```

The Next.js config uses `withEve()` from `eve/next`. In local
development it starts the app-local Eve agent on a random available port and
rewrites same-origin Eve endpoints like `/eve/v1/session` to that server, so
the client component can use `useEveAgent()` without configuring a host.

Set `EVE_BASE_URL` before starting Next.js to reuse an already-running Eve
server instead of letting `withEve()` start one:

```bash
EVE_BASE_URL=http://localhost:3000 pnpm --filter web-chat-next-template dev
```

When a linked Vercel project is detected, `withEve()` writes generated
`experimentalServices` to `.vercel/output/config.json` so Next.js deploys at
`/` and the app-local Eve agent runs behind the private
`/_eve_internal/eve` service prefix, then rewrites public Eve endpoints to that
private service.

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
