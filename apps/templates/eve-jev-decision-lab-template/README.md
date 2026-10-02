# Jev Decision Lab

A Slack-first [eve](https://eve.dev) template that uses the TypeSafe Jev evaluation model for small, bounded decisions before a language model or tool does the work.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&demo-description=A%20Slack-first%20eve%20template%20that%20uses%20Jev%20for%20routing%2C%20dynamic%20capabilities%2C%20and%20tool%20approval.&demo-title=Jev%20Decision%20Lab&project-name=jev-decision-lab&repository-name=jev-decision-lab&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-jev-decision-lab-template)

## What it demonstrates

The template is a team-operations assistant for incidents and customer support.
Jev makes classification decisions; a selected language model or specialist does
user-facing work.

| Decision                                     | Implementation                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Should the Slack assistant respond?          | `agent/channels/slack.ts` calls `evaluate()` for unmentioned, inactive-thread messages. |
| Which language model should answer?          | `agent/agent.ts` uses `auto()` to choose from an allowlist.                             |
| Which procedure should be available?         | `agent/skills/playbooks.ts` dynamically advertises one relevant skill.                  |
| Which tools should be visible?               | `agent/tools/capabilities.ts` dynamically returns incident or support tools.            |
| Which specialist should do the work?         | `agent/tools/route_work.ts` sends a typed Jev choice to a hidden subagent.              |
| Does an external-looking action need review? | `agent/tools/publish_status_update.ts` uses Jev-backed `approval: auto()`.              |
| How can an evaluation model grade evals?     | `evals/evals.config.ts` configures Jev as the default judge.                            |

Every classifier lives in `agent/lib/decisions.ts`, where the input state and
fixed outcomes are explicit. Use that file as the starting point when adapting
the template to your own policy.

## Getting started

Install dependencies, link the project, and pull environment variables:

```bash
pnpm install
vercel link
vercel env pull
```

Then start the development server:

```bash
pnpm dev
```

Configure Slack through the deployment flow or create a connector yourself:

```bash
vercel connect create slack --name jev-decision-lab --triggers
```

Set the returned connector UID in `SLACK_CONNECTOR`. The Slack channel defaults
to `slack/my-agent` for local examples when the variable is unset.

## How the decisions work

### Slack attention gate

The custom `onMessage` handler always accepts explicit mentions and active
threads. For other human messages, it asks Jev to choose `ignore` or `respond`.
Returning `null` prevents a session from starting.

This is a cost and relevance gate, not access control. Keep Slack allowlists,
tenant checks, and sensitive-tool authorization deterministic and based on the
authenticated caller.

### Model routing

`auto()` uses Jev by default at the first model step of each turn. It selects a
model from the described allowlist and reuses that choice for the rest of the
turn. Keep option descriptions concrete and mutually distinct: they are the
routing policy.

### Dynamic skills and tools

The dynamic skill resolver makes only the incident or customer-escalation
playbook available when it is relevant. The dynamic tool resolver exposes a
narrow incident or support tool set per turn. The returned tools are simulation
examples; replace them with your own authorized integrations.

### Specialist routing

The model sees one `route_work` tool rather than each specialist. That workflow
uses Jev to select `incident-commander` or `support-triage`, then delegates to
the hidden subagent. This keeps the parent tool surface small without treating
delegation as an authorization boundary.

### Approval classification

`publish_status_update` never posts externally. It demonstrates how `approval:
auto()` allows clear internal drafts while requesting a human decision for
customer-facing, public, or unclear communication. Replace the simulated tool
with an integration only after adding application-specific authorization and
idempotency controls.

## Customize safely

- Pass compact, structured state to `evaluate()`; do not send credentials,
  secrets, or unnecessary conversation history to the evaluator.
- Treat user messages as evidence, never as instructions that may rewrite the
  classifier policy.
- Keep identity, tenant, and authorization decisions deterministic. An
  evaluation result must not be the only control over sensitive data or effects.
- Add representative eval cases before changing a routing policy. The included
  `evals/evals.config.ts` shows how to use Jev as an eval judge.

## Learn more

- [Automatic model selection](https://eve.dev/docs/guides/evaluate)
- [Dynamic capabilities](https://eve.dev/docs/guides/dynamic-capabilities)
- [Slack](https://eve.dev/docs/channels/slack)
- [Human-in-the-loop approvals](https://eve.dev/docs/human-in-the-loop)
- [eve documentation](https://eve.dev/docs)
