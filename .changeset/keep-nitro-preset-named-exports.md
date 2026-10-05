---
"eve": patch
---

`eve build` keeps the named exports of the Nitro preset entry. Builds with presets such as `NITRO_PRESET=node-middleware` export `middleware` and `handleUpgrade` again instead of only `default`.
