import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": () => {
      const now = new Date();
      const currentDate = now.toLocaleDateString("en-US", {
        day: "numeric",
        month: "long",
        weekday: "long",
        year: "numeric",
      });
      const currentTime = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });

      const content = `# Date And Time

The current run date is ${currentDate}.
The current run time is ${currentTime}.
The current ISO timestamp is ${now.toISOString()}.

## Time And Calendar

- Ground relative phrases like "today", "yesterday", "last hour", and "since the deploy" in the current run time from this system context.
- When the user omits a window, prefer the alert or incident start from webhook metadata or the conversation when available. Otherwise use the last 6 hours from the current run time.`;

      return defineInstructions({ content });
    },
  },
});
