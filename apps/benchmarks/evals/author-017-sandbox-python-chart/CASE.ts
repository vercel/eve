import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/sandbox",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      [
        "Add a `bar_chart` tool to this agent. It takes a `title` and a list of `{ label, value }` bars, renders a bar chart PNG with Python's matplotlib inside the agent's sandbox, and returns the PNG as base64 in the tool result so our client can save it. The model doesn't need the image bytes, only to know that a chart was made, so keep them out of its context. If rendering fails, the tool should fail instead of reporting a chart.",
        "",
        "matplotlib isn't installed in the sandbox by default. Set it up once for all sessions instead of installing it on every call.",
        "",
        "Also make this field reference available in the sandbox at `reference/ticket-fields.md`, so the model can read it before it analyzes tickets:",
        "",
        "```md",
        "- priority: one of low, medium, high",
        "- minutes_to_resolve: minutes from opening to the first resolution",
        "```",
      ].join("\n"),
    );
  },
});
