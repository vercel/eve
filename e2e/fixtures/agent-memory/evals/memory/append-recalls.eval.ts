import { defineEval } from "eve/evals";

export default defineEval({
  description: "Appended dispatch memory keeps the newest record across a session compaction.",
  async test(t) {
    const session = await t.session();
    const opened = await session.send("Alice opens the dispatch shift. Check the unloading dock.");
    opened.expectOk();
    opened.messageIncludes("Dispatch record versions: [NORTH]");

    const updated = await session.send(
      "Bob takes over the dispatch shift. Check the unloading dock again.",
    );
    updated.expectOk();
    updated.messageIncludes("Dispatch record versions: [NORTH, SOUTH]");

    (await session.compact()).event("context.settled", {
      data: { kind: "compaction", outcome: "completed" },
    });

    const checked = await session.send("The next driver checks in. Confirm the unloading dock.");
    checked.expectOk();
    checked.messageIncludes("Dispatch record versions: [SOUTH]");
    t.succeeded();
  },
});
