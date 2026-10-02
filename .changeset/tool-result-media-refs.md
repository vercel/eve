---
"eve": patch
---

Files that tools return to the model now live in the session sandbox, with only a reference in session history, so workflow state no longer re-stores image bytes on every step; each model call sends the same file, keeping it visible on later turns and the provider's prompt cache valid. Compaction now counts images at roughly what providers bill for them instead of their base64 length, and `read_file` shows PNG, JPEG, GIF, and WebP files to the model as images. Message attachments and tool files now stage under `/workspace/.eve/attachments` instead of `/workspace/attachments`, so they no longer collide with an agent's own files.
