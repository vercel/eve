---
name: deep-investigation
description: Investigate an operational problem to determine what happened, assess its impact, and recommend next steps using a hypothesis-backed approach.
---

# Evidence-Backed Investigation

Investigate an operational problem using relevant evidence to explain what happened, assess the impact, and identify useful next steps.

## Procedure

### 1. Understand the request

Scan the conversation for:

- The reported symptom or unexpected behavior
- The affected service, environment, region, or workflow
- The relevant timestamps or time range
- Links to external context
- What the user needs to decide or do

Use available context first. Fetch additional context when it can change the conclusion or next action.

Perform a quick scan using available tools to determine if the problem is related to a recent, ongoing incident.

### 2. Generate hypotheses

After identifying what went wrong, generate 2-4 plausible root-cause hypotheses. Each must include:

- A short label
- Why the hypothesis is plausible based on the available context
- The signals that can validate or invalidate it

Prioritize the most plausible hypotheses and the signals most likely to distinguish between them.

### 3. Validate hypotheses and determine what happened

Investigate each hypothesis using the hypothesis-validation skill. For each hypothesis, determine whether it is validated, invalidated, or inconclusive and explain the conclusion with specific evidence.

Establish:

- What changed or failed
- When it started
- Whether it is ongoing, recovering, or resolved
- Which explanation is best supported by the evidence

Do not require a validated root cause. Clearly distinguish observed facts, supported explanations, and unknowns.

Record findings as you validate. Follow the Evidence rules in the agent instructions. Call `evidence_record`, `evidence_remove`, and `evidence_list` as those rules say.

### 4. Assess the impact

Determine:

- Which services, endpoints, regions, workflows, or users are affected
- How severe and widespread the effect is
- Whether the impact is increasing, stable, decreasing, or no longer present
- Which important impact could not be confirmed

Do not infer customer impact from an error or alert alone.

### 5. Choose next steps

Recommend 1-4 concrete actions based on the evidence. Prioritize actions that:

- Reduce current impact
- Confirm an important unknown
- Restore normal operation
- Prevent an unsafe or premature change

State what each action is expected to accomplish. Do not recommend broad follow-up work unless it helps with the current decision.

## Result

If the invoking prompt prescribes an exact output shape, follow it and fold the findings below into those sections rather than adding more headings. Otherwise, answer with:

### What happened

A short explanation of the observed behavior, timeline, current state, and best-supported cause. State important unknowns. Include related or recurring incidents only when this turn's evidence shows them. Do not state that no related incident exists because you do not have complete incident history to search.

### Impact

The confirmed scope and severity. Clearly identify impact that could not be confirmed.

### Next steps

A ranked list of 1-4 concrete actions for the responder.

## Boundaries

- Do not assume the request represents a declared incident.
- Do not require a root cause before giving useful next steps.
- If the task is to validate one specific hypothesis, do not generate new hypotheses. Use the hypothesis-validation skill.
