Use when the user asks for a daily summary, morning briefing, or "summarize my day".

Steps:

1. Load the user's active focus from injected memory when available.
2. Use the Linear connection to list issues assigned to the user that are not done (backlog, unstarted, triage, started). Never use `state: "open"`.
3. Produce a concise briefing with three sections:
   - **Today** — top priorities and active focus
   - **Linear** — assigned issues grouped by status (identifier, title, status)
   - **Suggested next** — one concrete next action

Keep it scannable. Match the user's language.
