import { defineTool } from "eve/tools";

import {
  containerComponents,
  describeComponentProps,
  uiCatalog,
  uiSpecSchema,
} from "../lib/ui-catalog";
import { lastRenderedTurn } from "../lib/ui-state";

const componentList = Object.entries(uiCatalog.data.components)
  .map(
    ([name, component]) =>
      `- ${name}: ${component.description}\n  props: ${describeComponentProps(name)}`
  )
  .join("\n");

export default defineTool({
  description: `Show the user rich UI instead of plain text, such as result cards, tables, or metrics. Use it after gathering real data (for example with web search). Call this once per reply, with everything in one spec. After it returns, always write one short sentence, such as a follow-up question, and stop. Never end with an empty reply. Never list, summarize, or link the results in text, since the person can already see them.

The input is a flat spec: \`root\` is the key of the top element, and \`elements\` maps each key to { type, props, children }, where children lists other element keys. Use the exact prop names below and pass null for optional props you don't need. Only ${containerComponents.join(", ")} accept children; to show several elements together, wrap them in a Stack.

Components:
${componentList}`,
  inputSchema: uiSpecSchema,
  execute(_input, ctx) {
    const turnId = ctx.session.turn.id;
    if (lastRenderedTurn.get().turnId === turnId) {
      throw new Error(
        "You already showed UI in this reply, and the person can see it. Don't call render_ui again. Finish with one short sentence."
      );
    }
    lastRenderedTurn.update(() => ({ turnId }));
    return {
      note: "The person can already see this UI. Don't call render_ui again in this reply, and don't repeat its contents. Finish with one short sentence.",
      rendered: true,
    };
  },
});
