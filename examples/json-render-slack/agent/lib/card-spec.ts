import { standardComponentDefinitions, type CardLimits } from "@json-render/chat";
import { z } from "zod";

/** The name of `agent/tools/card.ts`. */
export const CARD_TOOL = "card";

/**
 * What one Slack message holds. The Slack adapter degrades content past these (a second table
 * becomes a code block), so the tool rejects such specs and the model can split or trim them.
 */
export const SLACK_CARD_LIMITS: CardLimits = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 99,
  tableColumns: 20,
  chartLabel: 20,
  chartTitle: 50,
  chartSeries: 12,
  chartPoints: 20,
};

type ComponentName = keyof typeof standardComponentDefinitions;

// One typed variant per component, so the model sees each component's exact props in the
// tool's JSON Schema rather than a free-form `props` object.
const elementVariants = (Object.keys(standardComponentDefinitions) as ComponentName[]).map(
  (type) => {
    const definition = standardComponentDefinitions[type];
    const leaf = definition.slots.length === 0;
    return z
      .object({
        type: z.literal(type),
        props: definition.props,
        children: z
          .array(z.string())
          .describe(leaf ? "Always []." : "Keys of child elements, in order."),
      })
      .describe(definition.description);
  },
);

export const cardSpecSchema = z.object({
  root: z.string().describe("Key of the root element. The root element must be a Card."),
  elements: z
    .record(
      z.string(),
      z.discriminatedUnion(
        "type",
        elementVariants as [
          (typeof elementVariants)[number],
          ...(typeof elementVariants)[number][],
        ],
      ),
    )
    .describe("Flat map of element key to element. List the root first, then children in order."),
});
