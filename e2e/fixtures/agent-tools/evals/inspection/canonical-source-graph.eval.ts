import type { AgentInfoResult } from "eve/client";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Inspection projects the canonical source graph without duplicate runtime state.",
  async test(t) {
    const response = await t.target.fetch("/eve/v1/info");
    if (!response.ok) {
      throw new Error(`GET /eve/v1/info failed (${response.status}): ${await response.text()}`);
    }

    const info = (await response.json()) as AgentInfoResult;
    t.check(info.version, equals(3));
    t.check(
      info,
      satisfies<AgentInfoResult>((value) => {
        const staticTool = (name: string) => value.tools.static.find((tool) => tool.name === name);
        const dynamicTool = (slug: string) =>
          value.tools.dynamic.find((tool) => tool.slug === slug);
        const infoRoute = value.channels.find(
          (channel) => channel.method === "GET" && channel.urlPath === "/eve/v1/info",
        );
        const webSearchComposition = value.composition.shadowed.find(
          (entry) => entry.slot === "tools/web_search",
        );

        return (
          staticTool("bash")?.owner.kind === "framework" &&
          staticTool("override-target")?.owner.kind === "application" &&
          dynamicTool("connection_search")?.owner.kind === "framework" &&
          dynamicTool("override-provider")?.owner.kind === "application" &&
          value.sandbox?.owner.kind === "framework" &&
          infoRoute?.owner.kind === "framework" &&
          value.kernel.prepared.some((capability) => capability.name === "agent") &&
          value.kernel.prepared.some((capability) => capability.name === "web_search") &&
          value.kernel.reserved.some((capability) => capability.name === "final_output") &&
          webSearchComposition?.source.owner.kind === "framework" &&
          webSearchComposition.by.owner.kind === "application"
        );
      }, "canonical source ownership, composition, routes, and kernel projection"),
    );

    await t.send("Complete one ordinary turn without calling tools.");
    t.succeeded();
  },
});
