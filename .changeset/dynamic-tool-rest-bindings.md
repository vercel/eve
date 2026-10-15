---
"eve": patch
---

Dynamic tools now capture locals bound by an array rest element (`const [first, ...rest] = ...`) or a rest parameter (`(...args) =>`). Before, the hoisted callback threw `ReferenceError` and the resolver's tools were dropped.
