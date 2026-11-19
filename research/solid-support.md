---
issue: https://github.com/vercel/eve/pull/6621
status: in-progress
last_updated: "2026-11-19"
---

# Solid 2 support

> **AI status:** Written entirely by AI; human review pending.

[Solid 2.0](https://www.solidjs.com/blog/solid-2-0-the-long-hold/) went stable on November 16, 2026. It retires SolidStart: full-stack Solid is start mode of `@solidjs/vite-plugin`
(`solid({ start: true, ssr?: true })`), and deployment goes through platform Vite plugins such as
`nitro()` rather than Solid adapters. A Solid 2 app is therefore a Vite app, and `eveVite()` is
its server integration. This plan covers the `eve/solid` binding.

eve supports only Solid 2.x. Solid 1 apps can still use `eveVite()` and `SessionStore` from
`eve/client`, but get no binding.

## Depends on

- [#6619](https://github.com/vercel/eve/pull/6619): `eveVite()` registers `buildApp` only on Vercel
  builds. Before it, Solid's SSR start mode built no server bundle beside `eveVite()`.
- [#6620](https://github.com/vercel/eve/pull/6620): on Vercel, `eveVite()` writes a static Build
  Output for apps whose client output has a root `index.html`, which includes Solid's client start
  mode. Server-rendered apps add `nitro()`.

## `eve/solid` binding (minor)

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
      <For each={agent.messages()} keyed={(message) => message.id}>
        {(message) => <Message message={message()} />}
      </For>
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
  `baseUrl`, `resume`, `prewarm`, and the lifecycle callbacks. `useEveAgent` keeps parity with
  them rather than following Solid's `create*` naming.
- State fields are Solid accessors (`messages()`, `agents()`, `view()`, `error()`, `events()`,
  `session()`, `status()`). Each is a `createMemo` over one `createSignal(store.snapshot)`, so a
  reader of `status()` reruns only when the status changes.
- Subscribes and attaches the store in `onSettled`, on both server and client, and the callback's
  cleanup unsubscribes and detaches when the owner is disposed. Solid's server `onSettled` never
  runs its callback, so nothing connects during SSR, but it still claims a hydration id: calling
  it only in the browser shifts every later hydration key. Attaching in the component body is not
  an option: `resume` and `prewarm` update the store synchronously, and Solid 2 rejects signal
  writes in an owned scope (`REACTIVE_WRITE_IN_OWNED_SCOPE`).
- Throws without a reactive owner, such as at module level, because nothing would dispose the
  attached store.
- `solid-js` `^2.0.0` becomes an optional peer dependency.

No `eveSolid()` plugin: `eveVite()` covers dev, preview, and Vercel for every start-mode shape.

## Testing and docs

- Unit: Solid joins the shared case in `src/client/framework-bindings.test.ts`, asserting through a
  `createEffect` reader. Solid cases cover `resume`, a send before the component settles, the
  owner error, and equal hydration ids from Solid's server and browser builds. The unit config
  aliases `solid-js` to `dist/solid.js`, because Node's default conditions load the server build,
  where effects never run.
- Scenario (build area, `framework-solid-build`): local SSR build emits `dist/server/server.js`,
  which renders `eve/solid`; SSR with `nitro()` on Vercel gets the eve service and route; client
  start mode on Vercel gets the static Build Output with the SPA fallback (needs #6620).
- Public types: `eve/solid` in the packed declaration matrix with `solid-js`.
- Fixture: `apps/frameworks/solid` (SSR start mode, `nitro()`, `eveVite()`), built by the
  `framework-fixtures` smoke project.
- Docs: `docs/guides/frontend/use-eve-agent-solid.mdx`, plus Solid in the frontend hub,
  `useEveAgent` reference, TanStack Start guide, and integrations data.

The workspace's `minimumReleaseAge` of two days blocks the Solid 2 packages until
2026-11-20 11:32 UTC, so this PR adds exact-version `minimumReleaseAgeExclude` entries for them.

## Open questions

- Does Vercel use a Build Output that `vite build` writes for a project on the Vite framework
  preset? The #6620 preview deploy settles it before merge.
