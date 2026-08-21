---
"eve": patch
---

Treat a reply that is nothing but a sentinel-shaped tag as the empty-delivery marker, so a mangled token — a corrupted tag name, a closing or paired form, different casing or separators, stray whitespace, attributes, wrapping backticks, or trailing punctuation — is silenced instead of delivered to a channel as literal control text. The exact sentinel keeps its existing match-anywhere behavior, and a reply that merely mentions the marker is still delivered.
