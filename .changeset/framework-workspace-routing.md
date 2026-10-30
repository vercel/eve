---
"eve": patch
---

Discover agent workspaces in the Nuxt and SvelteKit integrations, proxy each member's named routes locally, and generate one Vercel service per member while preserving authored service configuration.

Keep SvelteKit workspace proxy targets and route rewriting stable across config reloads. Reject generated Vercel service names that collide with unrelated services instead of overwriting them, including in Next.js builds.

Thanks to @OwenKephart for the workspace integration contribution.
