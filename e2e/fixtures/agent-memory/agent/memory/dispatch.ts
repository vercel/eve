import { defineMemory, defineMemoryProvider } from "eve/memory";

export default defineMemory({
  scope: "dispatch",
  supersede: "append",
  provider: defineMemoryProvider({
    recall: {
      async "turn.started"({ turn }) {
        const input = JSON.stringify(turn.input);
        const dock = input.includes("Alice opens the dispatch shift")
          ? "NORTH"
          : input.includes("Bob takes over the dispatch shift")
            ? "SOUTH"
            : undefined;
        return dock === undefined
          ? null
          : { messages: [{ id: "unloading-dock", content: `UNLOADING_DOCK=${dock}` }] };
      },
    },
  }),
});
