import { defineEval } from "eve/evals";

export default defineEval({
  description: "Static tools smoke: authored modules and dependencies can use dynamic imports.",
  async test(t) {
    await t.send(
      "Call the `read-dynamic-dependency` tool. Reply with its marker exactly as returned.",
    );

    t.succeeded();
    t.calledTool("read-dynamic-dependency", {
      output: (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).authoredMarker === "authored-dynamic-import-loaded" &&
        (value as Record<string, unknown>).dependencyMarker === "dynamic-dependency-loaded",
    });
  },
});
