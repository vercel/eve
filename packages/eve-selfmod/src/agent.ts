import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  build: { externalDependencies: ["eve-selfmod"] },
  events: {
    "session.started": () =>
      process.env.EVE_DEV === "1"
        ? defineAgent({
            description:
              "Delegate here when the developer asks to change this eve agent or its authored source. " +
              "Describe the requested behavior change without guessing source paths or passing runtime skill paths under $HOME/.agents or /workspace/skills; the subagent discovers authored files under its /source mount. " +
              "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the developer does not mention files or source code. " +
              "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
              "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround. " +
              "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
              "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.",
            model: "anthropic/claude-sonnet-5",
          })
        : null,
  },
});
