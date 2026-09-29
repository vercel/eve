---
"eve": patch
---

The experimental Vercel schedule provider now declares `@vercel/schedules` as a runtime dependency, so published installs can use the provider without relying on a transitive installation. Provider fetches now receive the current operation's abort signal, and failed disable calls after inactive creation report that the schedule may remain active. Nested collection management tools use flattened, provider-safe names.
