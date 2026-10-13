---
"eve": patch
---

`eve build` now works for apps with mounted extensions on filesystems without hard-link support, such as some NFS and FUSE mounts. It no longer fails with `Unknown system error -524` while writing the authored module map.
