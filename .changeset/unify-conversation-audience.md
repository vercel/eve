---
"eve": minor
---

Add a typed `audience(input)` hook to `defineChannel`; `metadata()` now contains custom fields only and the `ChannelAudienceMetadata` type is removed. Channel epoch 19 extensions remain supported, while the default eve channel classifies anonymous callers as public, `user`/`service`/`runtime` callers as private, other principal types as unknown, with public-or-development trace content defaults.
