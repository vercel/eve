---
"eve": patch
---

Session stream requests that ask for a durable tail index now close after replaying that tail, preventing Web Chat restoration through framework proxies from leaving local workflow listeners attached. Generated Web Chat apps also pin Shiki 3.23 to match the current Streamdown code plugin and pass type checking.
