---
"eve": minor
---

Add an optional `id` to the experimental `defineDynamicSchedules`, so a schedule collection keeps its stored schedules when its file is renamed or moved.

Without `id`, the collection's name still comes from its path under `agent/schedules/`. To move a collection, set `id` to its old path-derived name. A collection that a mounted extension contributes uses its `id` as written, without the mount prefix.

`eve build` now fails when two collections in one agent resolve to the same name. A tool file that replaces or disables a collection's tools is named for the resolved name, `agent/tools/schedule__<name>.ts`.
