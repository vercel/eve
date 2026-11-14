---
"eve": patch
---

`ClientSession.send()` and `respond()` open the delivery's stream as the request goes out, so `delivery.stream()` and `delivery.result()` get their first events a round trip sooner.
