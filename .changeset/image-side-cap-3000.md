---
"eve": patch
---

Stop sessions from failing permanently once they hold more than 20 images. Anthropic rejects any image over 3000 pixels per side in a request with more than 20 images, including images resent from history, so a single large screenshot early in a session made every later model call fail.

Images now reach the model as bytes only up to 3000 pixels per side, down from 8000. Larger images, including ones already in a session's history, reach the model as their `Attached file <path>` label, and `read_file` asks the agent to resize them in the sandbox first. Claude downscales images above 2576 pixels anyway, so the lower cap costs no detail on Claude models.
