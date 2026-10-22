---
"eve": patch
---

OpenAPI connection tool calls now follow redirects only within the base URL's origin. A redirect to another origin is returned as the tool result, with its target in `location`, instead of followed, so credentials in custom headers, such as an `apiKey` security scheme's header, no longer reach the redirect target. A same-origin redirect loop now fails after 10 hops with an explicit error.
