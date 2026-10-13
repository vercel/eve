---
"eve": minor
---

An unhandled error in a dynamic value or a hook now fails the turn, so a hook that only observes should catch its own errors. A dynamic value that fails isn't recorded, and the next model call evaluates it again.
