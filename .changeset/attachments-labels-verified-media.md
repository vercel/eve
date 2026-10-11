---
"eve": patch
---

Every attachment now reaches the model with a label that names its sandbox path, including images and PDFs that also arrive as bytes, so the agent can pass a visible file to `bash` or open it again. eve checks image and PDF media types against the file's bytes. Only PNG, JPEG, GIF, and WebP images up to 3 MiB and 8000 pixels per side, and PDFs up to 20 MiB, go to the model as bytes, and tool results follow the same rule. A HEIC photo, an oversized screenshot, or a mislabeled file renders as its label instead of failing the model call. Live sessions pay one prompt-cache rewrite after upgrading.
