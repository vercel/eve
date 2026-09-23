---
"eve": patch
---

Fix `Cannot read properties of undefined (reading 'push')` failures in turns with MCP tools such as Notion when an app installs a different Zod version than eve bundles. Tool schemas now reach the AI SDK only as JSON Schema, MCP and other JSON Schema tools are advertised exactly as published and validated with a standard JSON Schema validator, and the `*_INPUT_SCHEMA` and `*_OUTPUT_SCHEMA` constants from `eve/tools/*` are JSON Schema-backed Standard Schemas instead of Zod objects.
