---
"eve": patch
---

Fixed a denial-of-service issue in `webFetch` with `format: "text"`: HTML text extraction now runs in linear time, so malformed pages, such as ones with unclosed `<script>` tags or stray `<` characters, can no longer block the event loop. Content after an unclosed `<script>`, `<style>`, or `<noscript>` tag is now dropped, matching browser behavior. Thanks @not2face for the report.
