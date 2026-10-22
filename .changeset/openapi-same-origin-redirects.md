---
"eve": patch
---

OpenAPI connection tool calls now follow redirects only within the base URL's origin. A redirect to another origin is returned to the model as the tool result instead of followed, so credentials in custom headers, such as an `apiKey` security scheme's header, no longer reach the redirect target.
