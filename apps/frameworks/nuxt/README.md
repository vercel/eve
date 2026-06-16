# Nuxt with Eve demo

A Nuxt 4 app with an embedded Eve agent, integrated through the `eve/nuxt`
module:

```ts
export default defineNuxtConfig({
  modules: ["eve/nuxt"],
});
```

The agent lives in `agent/` (instructions, tools, channels) next to the Nuxt
`app/` directory. In local development the module starts the Eve runtime
alongside the Nuxt dev server and proxies same-origin Eve endpoints to it.

## Run locally

```sh
pnpm --filter framework-nuxt dev
```

## Deploy

`vercel.json` declares two services: the Nuxt app at `/` and Eve behind the
private `/_eve_internal/eve` service prefix. See
[the Nuxt frontend docs](../../../docs/guides/frontend/nuxt.mdx) for details.
