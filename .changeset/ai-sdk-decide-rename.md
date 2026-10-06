---
"eve": minor
---

Breaking: follows the AI SDK rename from evaluation to decisions and updates to `ai@7.0.128`. `evaluate` from `eve/ai` is now `decide`, and `auto` and `t.judge(...)` accept `Experimental_DecisionModel` instances such as `provider.decisionModel(...)`. Replace `evaluate` imports with `decide` and `evaluationModel(...)` calls with `decisionModel(...)`. Extensions built against the previous `tool` or `dynamicTool` capability must be rebuilt against this release.
