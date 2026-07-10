---
"eve": patch
---

chatSdkChannel now mounts both GET and POST on each adapter's webhook route, so adapters that verify with a GET challenge like X's CRC check work through the bridge. POST-only adapters are unaffected.
