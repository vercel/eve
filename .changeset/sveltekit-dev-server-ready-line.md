---
"eve": patch
---

The SvelteKit plugin now proxies `/eve/v1/**` to the URL on eve's `server listening at ...` line. Before, it took the first URL in the dev server's output, so a documentation link in a dependency warning could become the proxy target and serve 404s.
