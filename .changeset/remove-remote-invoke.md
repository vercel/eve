---
"eve": minor
---

Replace `eve remote invoke` and its resumable JSON workflow with `eve remote connect --print <prompt>` for one-shot requests that print the final assistant text and exit. Interactive `eve remote connect` is unchanged; use `eve/client` for scripted multi-turn sessions and input responses.
