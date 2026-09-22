---
"eve": patch
---

Defer sandbox environment preparation during development until the first sandbox access, so startup and rebuilds no longer wait for optional engine installation. First access prepares all environments in that compiled generation; production builds still prepare eagerly.
