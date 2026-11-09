---
"eve": patch
---

Make local world stream reads scale with new chunks: a repeated `getInfo` or cursor `getChunks` on a long stream no longer reopens every earlier chunk file.
