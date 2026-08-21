---
"eve": patch
---

Fix authored module bundling for relative code imports whose basename contains dots, such as `./Reflect.getPrototypeOf` or `./mock-registry.schemas`.
