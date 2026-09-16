---
"eve": patch
---

Raise the OpenAPI schema dereference depth limit from 12 to 32 keyword levels. Deeply nested request bodies such as Notion's page properties were truncated to `{}` below the old limit, which turned the alternatives of a nested `oneOf` into indistinguishable empty schemas and made the generated tool validator reject valid input with "more than one option matched".
