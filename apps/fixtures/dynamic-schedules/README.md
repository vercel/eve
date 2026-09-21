# Dynamic schedules fixture

Exercises provider-backed `defineScheduleCollection(...)` authoring and its automatically generated management tools.

```sh
pnpm --filter dynamic-schedules dev
```

`vercelScheduleProvider()` uses process-local storage under `eve dev` and Vercel Schedules in a production Vercel deployment. Local schedules last only for the current process. To make this fixture use the real production Vercel Schedules control plane while running locally, link and pull the project environment, then start it with `DYNAMIC_SCHEDULES_USE_VERCEL=1 pnpm --filter dynamic-schedules dev`. This mutates schedules in the linked production project; firings target its production queue, not localhost. Registering `agent/schedules/collection.ts` contributes `schedule__collection__create`, `schedule__collection__list`, `schedule__collection__read`, `schedule__collection__update`, `schedule__collection__enable`, `schedule__collection__disable`, and `schedule__collection__delete`. Immediate invocation remains programmatic and is not model-facing by default.
