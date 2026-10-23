---
"eve": minor
---

Breaking: replace `eve remote invoke` and its resumable JSON workflow with `eve remote connect --print <prompt>` for one-shot remote requests. The new mode prints the final assistant text to stdout and exits; interactive `eve remote connect` remains unchanged. Use the `eve/client` API for scripted multi-turn sessions and input responses.
