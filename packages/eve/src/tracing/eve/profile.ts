import type { Attributes, MappingContext, OutputMapping } from "#tracing/lib/index.js";
import { currentTraceSessionId } from "#tracing/eve/agent-trace-context-store.js";

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
        else if (span.type === "channelRequest" && key === "agent.channel.name")
          output["eve.channel.name"] = value;
        else if (span.type === "channelRequest" && key === "agent.channel.kind")
          output["eve.channel.kind"] = value;
        else output[key] = value;
      }
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
