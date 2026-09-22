---
"eve": patch
---

Keep a delegated agent task open when its model turn yields with nested background work pending. Deliver the final result after that work finishes, including usage accumulated across the yielded turns, instead of reporting the interim reply as completion.
