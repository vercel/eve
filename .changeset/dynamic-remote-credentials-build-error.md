---
"eve": patch
---

The build now fails when a dynamic remote agent's `auth` or `headers` uses a value declared inside the event handler. Before, eve moved the credentials to module scope anyway, so they threw at request time or silently read a same-named module value. Dynamic remote agents imported through an alias or `import * as eve` now compile their credentials too.
