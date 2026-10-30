# harness-agent

A playground for the experimental `agent/harness.ts`. Its harness:

- answers `/plans` without the model;
- refuses `/refund`;
- offers the agent's own `remove_seat` tool only on the enterprise plan (the default plan is pro);
- adds an account preamble and a `plan_lookup` tool to every model call, and asks the model once
  per turn to cite the lookups it used.

```sh
pnpm --filter harness-agent dev
```
