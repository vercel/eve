import type { Attributes, MappingContext, OutputMapping } from "#tracing/lib/index.js";
import { currentTraceSessionId } from "#tracing/eve/agent-trace-context-store.js";

/** eve publishes tool call kind, outcome, and parent under its schema-4 `agent.action.*` names. */
const TOOL_ATTRIBUTES: Readonly<Record<string, string>> = {
  "agent.tool.kind": "agent.action.kind",
  "agent.tool.outcome": "agent.action.outcome",
  "agent.tool.parent_call_id": "agent.action.parent_call_id",
};

export function eveOutputMapping(options?: {
  readonly resolve: (span: MappingContext) => {
    readonly traceSessionId?: string;
    readonly platform: "vercel" | "other";
  };
}): OutputMapping {
  return {
    attributes(span, attributes) {
      const output: Record<string, Attributes[string]> = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (key === "agent.connection.name") output["eve.connection.name"] = value;
        else if (span.type === "tool" && TOOL_ATTRIBUTES[key] !== undefined)
          output[TOOL_ATTRIBUTES[key]] = value;
        else if (span.type === "approval" && key === "gen_ai.tool.name")
          output["agent.action.name"] = value;
        else if (span.type === "channelRequest" && key === "agent.channel.name")
          output["eve.channel.name"] = value;
        else if (span.type === "channelRequest" && key === "agent.channel.kind")
          output["eve.channel.kind"] = value;
        else output[key] = value;
      }
      if (span.type === "tool" && attributes["agent.tool.kind"] !== undefined)
        output["agent.action.name"] = attributes["gen_ai.tool.name"];
      if (attributes["agent.run.id"] !== undefined) {
        const context = options?.resolve(span) ?? {
          platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
          traceSessionId:
            typeof attributes["agent.run.id"] === "string"
              ? currentTraceSessionId(attributes["agent.run.id"])
              : undefined,
        };
        if (context?.platform === "vercel" && context.traceSessionId !== undefined)
          output["vercel.session_id"] = context.traceSessionId;
      }
      return output;
    },
    link: (_span, link) => ({
      "eve.link.type":
        link.relationship === "execution.delivery" ? "workflow.delivery" : link.relationship,
    }),
  };
}
