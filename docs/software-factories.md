---
title: "Software Factories"
description: "Decide when a software factory fits your team's work, how work moves from request to reviewed change, and which eve features each stage uses."
---

A software factory is a set of AI agents that turns work items, such as bug reports or maintenance requests, into changes ready for review. The factory defines how agents investigate a request, implement a change, check the result, and hand decisions back to people. eve coordinates those agents and keeps their progress durable.

## Why use a software factory

Writing code is one part of delivering a change. Someone also has to confirm that a reported problem exists, decide what should change, run checks, and review the result. As work accumulates, those handoffs become the bottleneck, even when agents write the code.

A software factory automates the handoffs. Each stage produces a result the next stage can use, so a reviewer receives the original request, the proposed change, and evidence from checks together. The [AI SDK team's software factory](https://vercel.com/blog/building-a-software-factory-for-ai-sdk) uses this approach for bug fixes, documentation updates, and backports.

## When a software factory fits

Software factories fit work that follows a repeatable process and has an outcome your team can evaluate:

- Investigating bug reports with reproducible failures and regression tests.
- Implementing well-defined changes that follow existing repository conventions.
- Preparing maintenance changes, such as backports, for review.

Start from a workflow your team already runs. Clear acceptance criteria, reliable checks, and available reviewers give the factory a basis for deciding whether work advances.

Exploratory work still needs close human direction. If a request leaves product behavior or a public API undecided, add a clarification or approval step before implementation. Without one, a factory can produce changes that pass tests but solve the wrong problem.

## How work moves through a factory

The stages depend on the repository and the work it receives. This sequence shows how a factory carries evidence from a request to a reviewable change:

| Stage          | Question it answers                                                                   | Result for the next stage                               |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Intake         | What is being requested, and is there enough information to investigate?              | Defined work or a request for clarification.            |
| Investigation  | Does the repository support the reported problem or requested change?                 | Findings and acceptance criteria.                       |
| Implementation | What code change satisfies those criteria?                                            | Code changes and check results on a branch.             |
| Review         | Does the actual diff meet the criteria without introducing unacceptable consequences? | Findings, requested revisions, or approval to hand off. |
| Human decision | Is this change appropriate to release?                                                | The decision to merge, revise, or stop.                 |

For example, an issue might claim that an API accepts invalid input. Investigation reproduces the failure before implementation starts. If the API already rejects that input, the factory returns its findings without changing code. Asking for clarification and stopping an unsupported request are useful outcomes, just as a pull request is.

## Where people make decisions

Your team decides which actions a factory may take and which require a person. For example, an agent can prepare a branch while changes to public behavior and release decisions wait for [human approval](./human-in-the-loop).

Give the review stage the actual diff and acceptance criteria, not the implementing agent's summary of its work. An independent review then has its own chance to inspect the code and evidence. People still judge whether the behavior belongs in the product and whether the evidence supports shipping it.

A factory also needs upkeep. Recurring failures point to missing context, unreliable checks, or work that needs a different approval rule, so maintain its checks and agent instructions as you would any other tooling.

## How eve supports a software factory

An orchestrator agent coordinates the work, and [subagents](./subagents) run each stage with their own instructions, tools, and conversation state. Each stage maps to an eve feature:

| Factory need                       | eve feature                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Receive work from GitHub or Linear | [Channels](./channels/overview) turn events and messages into agent sessions.                                        |
| Keep progress across interruptions | [Durable sessions](./concepts/execution-model-and-durability) preserve progress across turns, pauses, and redeploys. |
| Run repository commands            | A [sandbox](./sandbox) isolates the environment where agents inspect code and run checks.                            |
| Access external services           | [Connections](./connections) give agents scoped access to services without putting credentials in the prompt.        |
| Pause for a person                 | [Human-in-the-loop approvals](./human-in-the-loop) stop a tool call until someone approves it.                       |
| Inspect a run                      | [Agent Runs](./observability/agent-runs) shows the sessions and tool calls behind an outcome.                        |

Foreman, the [eve software factory template](https://vercel.com/templates/eve/eve-software-factory), is one implementation of this pattern. It routes GitHub and Linear work through classifier, analyst, implementer, and reviewer agents, and ends with a reviewed draft pull request. A person decides when to mark it ready and merge it.

## Build a software factory

- [Creating a Software Factory](https://vercel.com/academy/creating-a-software-factory): an Academy course that builds a factory that investigates requests and pauses for human decisions.
- [Build a software factory with eve](https://vercel.com/kb/guide/eve-software-factory): set up the Foreman template, connect work intake, and walk through its agent pipeline.
- [Give your software factory a browser](https://vercel.com/kb/guide/software-factory-browser): reproduce UI bugs and inspect fixes on preview deployments.
- [Manage Vercel projects with a software factory](https://vercel.com/kb/guide/software-factory-vercel-mcp): add deployment context through Vercel MCP to investigate failed builds and runtime errors.
