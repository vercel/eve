# Dynamic schedules fixture

Exercises provider-backed `defineScheduleCollection(...)` authoring and its automatically generated management tools.

```sh
pnpm --filter dynamic-schedules dev
```

The in-memory provider keeps schedules only for the current process. Registering `agent/schedules/collection.ts` contributes `collection__create_schedule`, `collection__list_schedules`, `collection__read_schedule`, `collection__update_schedule`, `collection__enable_schedule`, `collection__disable_schedule`, and `collection__delete_schedule`. Immediate invocation remains programmatic and is not model-facing by default.
