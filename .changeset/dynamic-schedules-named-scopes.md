---
"eve": minor
---

A dynamic schedules definition can declare named `scopes`, for one kind of schedule with more than one owner.

`scopes` takes the place of `scope`. The definition still offers one set of management tools, and each tool takes a `scope` input that names the scope to act in. A scope can set its own `description`, `preparePayload`, `run`, and `approval`, and an `id` that keeps the schedules an earlier definition stored. `schedules(definition, { scope })` binds one scope from code. A definition with a single `scope` is unchanged.
