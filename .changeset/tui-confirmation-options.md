---
"eve": patch
---

The dev TUI now renders the session token-limit continuation prompt as a proper question — prompt copy and labeled Approve/Stop options in the question pane — instead of a generic y/n tool-approval line, and answers every confirmation prompt with the request's own option ids instead of hardcoded `approve`/`deny`. Previously, approving the continuation prompt in the TUI submitted an option the server did not recognize, so the same prompt was re-raised indefinitely.
