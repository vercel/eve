---
name: suggest-follow-ups
description: Suggest high-leverage incident follow-up actions from established root cause and incident context. Activate when asked for follow-ups, action items, preventive measures, or "what should we do so this doesn't happen again" after an incident.
---

# Suggest Follow-ups

Turn an incident's root cause, timeline, and blast radius into a short, ranked list of high-leverage follow-up actions. Suggest only; do not file follow-ups.

Prefer an established root cause. If root cause is unknown, do not investigate to invent one. Suggest only what available context supports, state that prevention-level follow-ups are premature, and recommend `deep-investigation` first if deeper follow-ups are wanted.

## Procedure

### Step 1: Gather what went wrong

From the incident channel and supporting evidence, identify:

- Root cause — the underlying fragility, not just the trigger
- Timeline — detection, diagnosis, and mitigation speed
- Blast radius — services, endpoints, or users affected, and severity
- Issues that made the timeline slow or blast radius large

If these facts are not already in the thread, read the incident thread with Slack tools. Do not run new Datadog or GitHub queries to expand the investigation.

### Step 2: Load existing follow-ups

Scan the thread for follow-ups that people already named. Do not duplicate those items. If this is a repeat incident, raise priority and note that earlier mitigation did not hold.

### Step 3: Map to categories

Weight toward where this incident actually hurt:

- **Prevent** — eliminate the cause or class of cause
- **Detect faster (MTTD)** — close a genuine detection gap
- **Mitigate faster (MTTR)** — rollback automation, kill switch, missing runbook, missing dashboard
- **Limit blast radius** — rate limiting, load shedding, circuit breaker, isolation, graceful degradation

If detection was already fast but recovery was slow, prefer mitigation over more alerts.

### Step 4: Apply a high bar

A follow-up qualifies only if it is durable/systemic, targets the failure class, is worth the cost, and is verifiable. Drop process-vigilance items ("be careful", "add review", "remind").

A proposed alert must also be symptom-based, actionable, page-worthy only if urgent, threshold-tuned, and prefer fixing/consolidating an existing monitor over adding a new one.

### Step 5: Rank

Order survivors by leverage — cheap, high-impact, fast-to-land first. Typically one to three items. If nothing clears the bar, say so rather than inventing low-value items.

## Result

A short ranked list of suggested follow-ups, each with priority, action, and one sentence on why it matters tied to evidence.

## Boundaries

- Suggest only. Do not file follow-ups in an external system.
- Do not investigate or run new observability/code queries to manufacture a root cause.
- Do not assign owners.
