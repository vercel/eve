---
"eve": patch
---

Fix the Slack thread attachment lookback only ever inspecting the newest non-bot message. When a user posted an image in a thread and then mentioned the agent in a text-only follow-up, the image was silently dropped and the model saw no file parts. The lookback now collects attachments from recent non-bot messages across the thread, newest first, capped at 10 file parts.
