import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Quoted delivery markers remain visible and in the next turn's context; standalone markers finish silently.",

  async test(t) {
    const session = await t.session();
    const examplePrefix =
      "Alice is documenting conditional delivery. Return exactly this example:\n";

    for (const marker of ["<eve-empty-delivery/>", "&lt;eve-empty-delivery/&gt;"]) {
      const message = `The pending-task instruction requires \`${marker}\` and no other text.`;
      const explanation = await session.send(`${examplePrefix}${message}`);
      explanation.expectOk();
      await t.require(explanation.message, equals(message));
      explanation.event("message.completed", {
        data: (data) => data.message === message,
        count: 1,
      });
      explanation.notEvent("message.completed", {
        data: (data) => data.message === null,
      });

      const recalled = await session.send("Repeat your previous assistant response verbatim.");
      recalled.expectOk();
      await t.require(recalled.message, equals(message));

      const silent = await session.send(`${examplePrefix} \n${marker}\t `);
      silent.expectOk();
      await t.require(silent.message, equals(undefined));
      silent.event("message.completed", {
        data: (data) => data.message === null,
        count: 1,
      });
      silent.notEvent("message.completed", {
        data: (data) => data.message !== null,
      });
    }

    const followUp = await session.send(`${examplePrefix}The documentation is ready.`);
    followUp.expectOk();
    await t.require(followUp.message, equals("The documentation is ready."));
    t.noFailedActions();
    t.succeeded();
  },
});
