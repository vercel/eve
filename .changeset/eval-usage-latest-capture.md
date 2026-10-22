---
"eve": patch
---

An eval's `derived.usage` now takes each session's latest usage by time. An eval that captured a session again with an earlier snapshot reported that snapshot's lower total. Its `costUsd` is now absent when a counted session reported no cost, instead of summing only the sessions that did.
