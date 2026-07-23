# Framework apps

These apps verify eve's frontend framework integrations and act as runnable examples for maintainers.

- `framework-next` covers `eve/next` and `withEve()`.
- `framework-next-multi-agent` covers `withEve({ agents })` and named `useEveAgent({ agent })` calls.
- `framework-nuxt` covers the `eve/nuxt` module.
- `framework-sveltekit` covers the `eve/sveltekit` Vite plugin.

Keep these apps small and focused on framework wiring. Smoke-test-only behavior belongs in `apps/fixtures`.
