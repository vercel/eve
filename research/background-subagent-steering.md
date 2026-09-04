---
issue: https://github.com/vercel/eve/pull/3016
status: implementing
last_updated: "2026-09-04"
---

# Background subagent steering

A message addressed to a busy background child's `agentId` should cancel its previous task and continue the same child session with the updated instruction.

The [real-model baseline](https://github.com/vercel/eve/actions/runs/33834282481/job/100903508168) exposed both boundaries: one parent addressed the correct child but received `AGENT_BUSY`; another acknowledged steering without forwarding it. The unrelated-follow-up control passed.

## Contract

Reuse the existing subagent input `{ agentId, message, outputSchema? }`. An idle child continues normally. For a running background child, the runtime commits cancellation of the task that owns the child, requests cancellation of its turn, and releases that task's claim before admitting the replacement task. The receipt preserves `agentId` and changes `taskId`. The child retains its session, history, and workspace.

Only a task in the calling session's index can be cancelled. Tool-name and local/remote target mismatches are rejected before cancellation. Starting children without a confirmed address and blocking workflow owners remain busy. A cancellation failure prevents the ownership transfer. Already-completed side effects cannot be undone.

Late task results cannot change a cancelled task to completed. Late owner release and child settlement are scoped to the previous owner, so they cannot release the replacement task's claim. Concurrent continuations in the same model batch cannot cancel a replacement task that has not yet been admitted.

The framework prompt directs the parent to forward user steering to the affected child. Unrelated follow-ups do not propagate to background work. A separate steering tool would duplicate the existing address and message contract; automatic propagation would lose the parent's choice of target.

## Validation

Keep the three real-model evals from #3016 unchanged. Test cancellation ordering, cancellation failure, ownership and target validation, replay, and late owner release independently. Run the model evals in CI against both the idle-parent and active-parent paths before treating this implementation as verified.
