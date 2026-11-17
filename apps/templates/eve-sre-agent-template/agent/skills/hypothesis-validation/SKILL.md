---
name: hypothesis-validation
description: Given a hypothesis, take the necessary investigation steps to validate, invalidate, or reach an inconclusive result for the hypothesis.
---

# Hypothesis Validation

Investigate the related context for a given hypothesis holistically. Record evidence and conclude whether the hypothesis is validated, invalidated, or inconclusive.

## Procedure

### 1: Context hydration

Scan the conversation for:

- alert or incident metadata
- service names, environment names, region hints
- timestamps or time ranges
- symptoms (errors, latency, downtime)
- links to external pieces of context

The goal here is getting a quick hydration of possibly relevant context for the hypothesis before doing a deeper dive.

### 2: Dig deep

After identifying possibly relevant context, dig deep into the most relevant pieces of context to gather enough evidence to validate, invalidate, or reach an inconclusive result for the hypothesis.

Record findings as you dig. Follow the Evidence rules in the agent instructions. Call `evidence_record`, `evidence_remove`, and `evidence_list` as those rules say.

### 3: Draw conclusions

After gathering enough evidence, draw a final conclusion about the hypothesis. The conclusion for the hypothesis should be "validated", "invalidated", or "inconclusive". Include a description that cites the most important pieces of evidence used to draw the conclusion.

## Result

A synthesized conclusion for the hypothesis.

## Boundaries

- Do not use this skill to run a full investigation. Use the deep investigation skill.
