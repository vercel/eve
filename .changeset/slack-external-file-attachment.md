---
"eve": patch
---

Fix the Slack channel crashing a whole turn when a thread contained a "remote file" — a Google Drive, Dropbox, or Box document shared via an external Slack integration (`mode: "external"`). These files' `url_private` points at the third-party service, not Slack, so downloading them with the Slack bot token failed (typically a 401), throwing an `AI_DownloadError` for every later mention in that thread. Remote files are now excluded from attachment collection across all three inbound paths (mention attachments, thread-history lookback, and the shared Chat SDK webhook payload).
