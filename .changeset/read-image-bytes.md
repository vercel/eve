---
"eve": patch
---

Detect PNG, JPEG, GIF, and WebP files from their bytes in `read_file`, so images with missing or incorrect filename extensions remain viewable. Text files are always read as text, even with an image extension, and unreadable binary files now get a clear error.
