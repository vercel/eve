---
issue: https://github.com/vercel/eve/pull/6621
status: in-progress
last_updated: "2026-11-18"
---

# Solid 2 support

> **AI status:** Written entirely by AI; human review pending.

[Solid 2.0](https://www.solidjs.com/blog/solid-2-0-the-long-hold/) went stable on November 16, 2026. It retires SolidStart: full-stack Solid is now start mode of `@solidjs/vite-plugin`
(`solid({ start: true, ssr?: true })`), and deployment goes through platform Vite plugins such as
`nitro()` rather than Solid adapters. A Solid 2 app is therefore a Vite app, and `eveVite()` is
its server integration.

eve supports only Solid 2.x. Solid 1 apps can still use `eveVite()` and `SessionStore` from
`eve/client`, but get no binding.

## Spike results

Spike on 2026-11-18 with `solid-js@2.0.1`, `@solidjs/web@2.0.1`, `@solidjs/vite-plugin@3.0.1`,
`vite@8.3.8`, `nitro@3.0.261103-rc`, and `eve` packed from `main`. `EVE_BASE_URL` pointed at a stub
server that recorded every request.

| Path                  | SPA (`start: true`)        | SSR (`ssr: true`)          | SSR + `nitro()`            |
| --------------------- | -------------------------- | -------------------------- | -------------------------- |
| `vite` dev proxy      | Works                      | Works                      | Works                      |
| local `vite build`    | Works; stray `dist/server` | Broken: no server bundle   | Works                      |
| `vite preview`        | Works                      | Broken: `/` returns 500    | Proxy absent (documented)  |
| `VERCEL=1 vite build` | Fails: no `.vercel/output` | Fails: no `.vercel/output` | Works: eve service + route |

Start mode's dev handler does not intercept `/eve/v1/*`; Vite's proxy answers first. No
Solid-specific server plugin is needed.

### Bug: `eveVite()` suppresses other plugins' builds

`eveVite()` always declares a `buildApp` hook, even though it does nothing outside Vercel builds.
Solid treats any non-`pre` `buildApp` hook as a host that owns the build
(`solid:client-build-first/complete`), so it builds the client and leaves the SSR environment for
eve, which returns early. Local SSR builds ship without `dist/server/server.js`, and SPA builds
keep a server directory Solid would otherwise remove. Declaring `buildApp` only when
`process.env.VERCEL` is set fixed both in the spike, with no change to Vercel builds. Any Vite
framework that uses the same heuristic is affected.

## Proposal

### 1. Fix `eveVite()`'s `buildApp` hook (patch)

Register `buildApp` only for Vercel builds, in the shared `createEveVitePlugin`, so `eveVite`,
`eveSvelteKit`, and `eveTanStack` all get the fix. No API change.

### 2. Static Build Output fallback in `eveVite()` (minor)

Today a Vite app whose build writes no `.vercel/output` fails on Vercel until the user composes
`withEve` in `vercel.ts`. That covers every plain Vite SPA, including Solid's default start mode.

On Vercel builds, after all environments are built, when no `.vercel/output/config.json` exists:

- If the client environment's `outDir` contains `index.html`, `eveVite()` writes a Build Output:
  the client output under `static/`, and routes `[{ handle: "filesystem" }, { src: "/(.*)",
  dest: "/index.html" }]`. The existing service writer then puts each agent's route before
  `filesystem`.
- Otherwise the app renders on a server, and the build fails with a precise error: add `nitro()`
  from `nitro/vite`, or compose eve in `vercel.ts` with `withEve`.

The spike produced the expected output for the Solid SPA and the expected error for Solid SSR.
A `vercel.json` with `services` or a `vercel.ts` with `withEve` still takes precedence, unchanged.

```text
vite build (VERCEL=1)
  ├─ adapter/Nitro wrote .vercel/output ──▶ add eve services        (today)
  ├─ client has index.html ──────────────▶ write static output ──▶ add eve services
  └─ server-rendered, no output ─────────▶ error: add nitro() or use withEve
```

### 3. `eve/solid` binding (minor)

```tsx
import { useEveAgent } from "eve/solid";

function Chat() {
  const agent = useEveAgent();
  const [text, setText] = createSignal("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void agent.send(text());
        setText("");
      }}
    >
      <For each={agent.messages()}>{(message) => <Message message={message} />}</For>
      <input
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        disabled={agent.status() !== "idle"}
      />
    </form>
  );
}
```

- Same name, options, and methods as the React, Vue, and Svelte bindings, including `agent`,
  `baseUrl`, `resume`, `prewarm`, and the lifecycle callbacks.
- State fields are Solid accessors (`messages()`, `agents()`, `view()`, `error()`, `events()`,
  `session()`, `status()`), derived from one signal that `SessionStore.subscribe` updates.
- Each accessor is a `createMemo` over a `createSignal(store.snapshot, { equals: false })`, so a
  reader of `status()` reruns only when the status changes.
- In the browser, subscribes and attaches the store in `onSettled`, and the callback's cleanup
  unsubscribes and detaches when the owner is disposed. Attaching in the component body is not an
  option: `resume` and `prewarm` update the store synchronously, and Solid 2 rejects signal writes
  in an owned scope (`REACTIVE_WRITE_IN_OWNED_SCOPE`). During start-mode SSR the accessors return
  the initial snapshot and nothing attaches.
- `solid-js` `^2.0.0` becomes an optional peer dependency.

### 4. No `eveSolid()` plugin

`eveVite()` covers dev, preview, and Vercel for every start-mode shape once 1 and 2 land. A
named plugin would only add surface.

## Testing and docs

- Unit: Solid joins the shared case in `src/client/framework-bindings.test.ts`, asserting through a
  `createEffect` reader, plus browser `resume` and SSR no-connect cases. Under Node's default
  conditions `solid-js` resolves to its server build, where effects never run, so the unit config
  aliases `solid-js` to `dist/solid.js`. The tests fail with the server build, without the signal
  update, without cleanup, without the browser guard, and with attachment in the component body.
- Scenario (build area, `framework-solid-build`): local `vite build` of start mode with SSR and
  `eveVite()` emits `dist/server/server.js`, which renders `eve/solid` with its initial state
  (fails before proposal 1); `VERCEL=1` with `nitro()` gets the eve service and route. The static
  fallback scenarios belong to proposal 2. A dev-proxy scenario was skipped.
- Public types: `eve/solid` in the packed declaration matrix with `solid-js`.
- Fixture: `apps/frameworks/solid` (start mode, SSR, `nitro()`, `eveVite()`), built by the
  `framework-fixtures` smoke project.
- Docs: `docs/guides/frontend/use-eve-agent-solid.mdx`; the frontend hub, `useEveAgent` reference,
  and `vite.mdx` intro name Solid. Proposal 2 owns the `vite.mdx` deploy text.

## Delivery

1. PR 1, `fix:` with a patch changeset: proposal 1 and its regression scenario.
2. PR 2, `feat:` with a minor changeset: proposal 2.
3. PR 3, `feat:` with a minor changeset: proposals 3–4, fixture, docs.

The workspace's `minimumReleaseAge` of two days blocks the Solid 2 packages until
2026-11-20 11:32 UTC. PR 3 adds exact-version `minimumReleaseAgeExclude` entries for `solid-js`,
`@solidjs/signals`, `@solidjs/web` (2.0.1), `@solidjs/vite-plugin` (3.0.1), and
`@solidjs/compiler` with its platform packages (2.0.0). They can be removed once those versions
mature. PRs 1 and 2 need Solid only for their scenarios, which install with no release-age limit.

## Open questions

- Does Vercel use a Build Output that `vite build` writes for a project on the Vite framework
  preset? A preview deploy of PR 2 settles it before merge.
- `useEveAgent` matches the other bindings; Solid convention would be `createEveAgent`. This
  proposal keeps parity.
