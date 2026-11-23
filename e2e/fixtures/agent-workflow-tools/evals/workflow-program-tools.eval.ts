import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "workflow({ mode: 'execute', tools: true }) discovers and calls an MCP connection tool, pauses for approval on a workflow tool, and calls a child subagent inside one bundled program.",
  timeoutMs: 90_000,
  async test(t) {
    const alice = {
      "x-eve-forwarded-principal-id": `workflow-program-alice-${crypto.randomUUID()}`,
    };
    const session = await t.session({ headers: alice });
    const parked = await session.send(
      "WORKFLOW-PROGRAM-TOOLS-START Alice checks catalog items, requests approval for the api release, and collects a marker note.",
    );

    session.requireInteraction({ toolName: "gated_deploy", display: "confirmation" });
    parked.calledTool("workflow", { count: 1, status: "pending" });
    parked.calledTool("public-catalog__list_items", { count: 1, status: "completed" });
    parked.calledTool("gated_deploy", { count: 1, status: "pending" });
    parked.event("turn.paused", { count: 1 });
    parked.notEvent("turn.settled");

    const resumed = await session.respondAll("approve");
    resumed.expectOk();
    resumed.notEvent("turn.started");
    resumed.event("interaction.settled", { count: 1 });
    resumed.calledTool("gated_deploy", { count: 1, status: "completed" });
    resumed.calledTool("workflow", { count: 1, status: "completed" });
    resumed.messageIncludes("WORKFLOW-PROGRAM-TOOLS-RESULT");
    resumed.messageIncludes("public-catalog__list_items");
    resumed.messageIncludes("Lamp");
    resumed.messageIncludes('"deployed":"api"');
    resumed.messageIncludes('"note":"WORKFLOW-CHILD:');
    resumed.messageIncludes("release-check");

    const allEvents = [...parked.events, ...resumed.events];
    const workflowCallId = parked.toolCalls.find((call) => call.name === "workflow")?.callId;
    resumed.eventsSatisfy(
      "nested program calls and child session belong to the workflow call",
      () => {
        if (workflowCallId === undefined) return false;
        const requested = new Map<string, string | undefined>();
        let markerCallId: string | undefined;
        let markerSettled = false;
        let childOpened = 0;
        for (const event of allEvents) {
          if (event.type === "call.requested") {
            requested.set(
              event.data.capability.name,
              "callId" in event.data.owner ? event.data.owner.callId : undefined,
            );
            if (event.data.capability.name === "workflow-marker") {
              markerCallId = event.data.callId;
            }
          }
          if (
            event.type === "call.settled" &&
            markerCallId !== undefined &&
            event.data.callId === markerCallId &&
            event.data.outcome === "completed"
          ) {
            markerSettled = true;
          }
          if (event.type === "child.opened" && event.data.name === "workflow-marker") {
            childOpened += 1;
          }
        }
        return (
          markerSettled &&
          childOpened === 1 &&
          requested.get("public-catalog__list_items") === workflowCallId &&
          requested.get("gated_deploy") === workflowCallId &&
          requested.get("workflow-marker") === workflowCallId
        );
      },
    );
  },
});
