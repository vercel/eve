---
"eve": patch
---

Agents whose OpenAI model is served by an endpoint without OpenAI web search, such as Amazon Bedrock through `createOpenAI({ baseURL })` or AI Gateway, now retry the step without `web_search` instead of failing every turn. A direct model then leaves `web_search` out of later calls.
