---
"eve": patch
---

Fix `Cannot read properties of undefined (reading 'push')` failures in turns with MCP tools such as Notion, and with the file-memory tools, when an app installs a different Zod version than eve bundles. Tool schemas now reach the AI SDK only as JSON Schema, MCP and other JSON Schema tools are advertised exactly as published and validated with a standard JSON Schema validator, and the `*_INPUT_SCHEMA` and `*_OUTPUT_SCHEMA` constants from `eve/tools/*` are JSON Schema-backed Standard Schemas instead of Zod objects.

eve now ships a single private copy of Zod instead of bundling several. `eve/client` no longer exports `AgentInfoResultSchema`, `HealthResultSchema`, `inputOptionSchema`, `inputRequestKindSchema`, `inputRequestSchema`, or `inputResponseSchema`, and `eve/self-modification` no longer exports `selfModificationConfigSchema`; use the exported types together with `isInputRequest`, `isInputResponse`, and `parseInputResponse`.
