---
"eve": patch
---

Add `eve/models/orcarouter`, a named model factory for the [OrcaRouter](https://www.orcarouter.ai) AI gateway. `orcarouter()` returns an OpenAI-compatible chat model served through `https://api.orcarouter.ai/v1`, defaulting to the `orcarouter/auto` router model and reading `ORCAROUTER_API_KEY` for credentials.
