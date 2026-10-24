---
"eve": patch
---

Chat SDK channels now handle adapters that reject edits without throwing `NotImplementedError`. When an edit fails, the channel posts the completed reply or sign-in result as a new message; previously these adapters, such as WhatsApp, left replies at their first streamed chunk and never said a sign-in had finished. Only `NotImplementedError` stops edits for the rest of the session.
