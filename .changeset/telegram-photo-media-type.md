---
"eve": patch
---

Telegram photos now keep their known image media type instead of being overridden by the file endpoint's `application/octet-stream` content-type, so image upload policies accept them and vision models can read them.
