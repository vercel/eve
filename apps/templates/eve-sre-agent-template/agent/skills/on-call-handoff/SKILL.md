---
name: on-call-handoff
description: Summarize a personal or team on-call shift from supplied context, Slack, Datadog, GitHub, and Vercel. Activate when asked for an on-call handoff, shift summary, rotation handoff, what to tell the next on-call, or leaving on-call.
---

# On-call handoff

Create an accurate handoff that covers notable incidents, pages, operational changes, and open actions. Do not investigate open incidents in depth.

## Procedure

### 1. Set the scope

Identify the team, shift start, shift end, and next responder from the request or conversation. Ask one targeted question only when a missing value blocks the handoff.

### 2. Collect shift context

Use the supplied webhook metadata first. Read Slack only when the request points to relevant channels or threads. Use Datadog for page, monitor, or service-health facts. Use GitHub when a deploy, pull request, or code change matters.

Do not require an external incident-management connection. State when the available sources cannot confirm a count, owner, schedule, or follow-up.

### 3. Select notable events

Include high-severity events, recurring pages, ongoing impact, and events with useful operational lessons. Keep low-signal events in a short count or omit them.

### 4. Identify changes and open actions

Record mitigations, deploys, alert changes, and other concrete improvements made during the shift. List unresolved actions with an owner and due date only when the evidence provides them.

### 5. Write the handoff

Return the handoff in chat. Use `references/template.md` as the structure. Mark missing data as "Could not confirm from available sources."

## Result

The handoff doc detailed in step 5.

## Boundaries

- Do not re-investigate alerts/incidents from scratch
