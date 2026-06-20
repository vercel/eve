---
"eve": minor
---

`defineDynamic` accepts `namespace: false` to expose map entries under their bare key (e.g. `talk-like-a-dog`) instead of the slug-qualified `custom__talk-like-a-dog`, for dynamic tools and skills. Dynamic tools and skills now also override a same-named authored one (previously skills threw on conflict and tools kept the authored one); two dynamic resolvers emitting the same name still throws.
