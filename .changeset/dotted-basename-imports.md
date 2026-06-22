---
"eve": patch
---

Resolve extensionless relative imports whose target basename contains dots when bundling authored modules. Local files such as `./mock-registry.schemas` and dependency requires such as `./Reflect.getPrototypeOf` now probe Eve's configured `.ts` and `.js` extensions before being treated as asset imports.
