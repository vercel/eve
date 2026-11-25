---
"eve": patch
---

On an OpenAI model, eve now fixes the `tools` array at a session's first request and loads a tool that appears later as an `additional_tools` message, so OpenAI keeps the history's reasoning.

A tool that is not in the fixed set is marked `omitFromRequestTools` and announced once by a system message that stays in the history. Other providers send the same requests as before.
