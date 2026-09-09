---
"eve": minor
---

Queue session events locally and persist them eagerly in order, removing stream setup and write backpressure from model preparation. Authored hooks now run after enqueueing rather than confirmed persistence; steps flush before completing, and storage failures interrupt active model work.
