---
"eve": patch
---

Local traces now record `agent.turn` with the turn's real duration instead of a zero-duration marker, and the separate `agent.turn.terminal` marker span is gone — terminal and transition events land on the turn span itself. `agent.session` window roots remain zero-duration markers because an idle session never closes.
