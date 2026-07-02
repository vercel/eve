---
"eve": minor
---

Replaced the `experimental.useCodexSubscription` flag with the `experimental_codex(model, fallback?)` model value. Set `model: experimental_codex("gpt-5.5")` to serve the model through your local Codex login during development; production builds keep the model on its `openai/<model>` AI Gateway route when the gateway catalog confirms the id, otherwise they compile the fallback model — and fail the build when none is provided.
