# Compliance agent

A governance-focused eve fixture demonstrating policy-driven tool approval patterns
for regulated workflows. Each tool uses a different approval strategy to model the
four policy effects proposed in [#145](https://github.com/vercel/eve/issues/145).

| Tool                | Approval                  | Effect demonstrated                                |
| ------------------- | ------------------------- | -------------------------------------------------- |
| `initiate_transfer` | Custom `Approval<TInput>` | deny (AML pattern) · escalate (high-value) · allow |
| `fetch_customer`    | `once()`                  | ask once per session, then allow automatically     |
| `record_audit`      | `never()`                 | always allow — pure audit sink                     |

## Run locally

```sh
pnpm dev
```

## Policy effects

- **deny** — `initiate_transfer` returns `{ type: "denied" }` for narrations that match
  a suspicious-pattern regex before the tool executes.
- **escalate** — Transfers above 10 000 in the currency's major unit (1 000 000 minor
  units) return `{ type: "user-approval" }`, surfacing a human approval step.
- **allow (session-scoped)** — `fetch_customer` uses `once()`: the first call in a session
  asks for approval; subsequent calls proceed automatically via `approvedTools`.
- **allow (unconditional)** — `record_audit` uses `never()` and always executes, providing
  a tamper-evident compliance trail regardless of other decisions.
