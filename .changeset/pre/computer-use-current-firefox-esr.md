---
"eve": patch
---

Computer use installs again because the sandbox takes the Firefox ESR line Mozilla currently serves instead of requiring ESR 140, which Mozilla no longer offers.

The managed Firefox profile also skips the Terms of Use dialog that ESR 153 opens over the first page. `COMPUTER_USE_REVALIDATION_KEY` changes, so templates that include it rebuild and drop the cached ESR 140, which no longer gets security fixes. Thanks @treydoe1 for reporting this in #5829.
