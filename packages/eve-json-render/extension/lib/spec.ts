import { standardComponentDefinitions, type CardLimits } from "@json-render/chat";
import { z } from "zod";

/** The media type of a json-render card spec, which the `card` tool writes and its renderer draws. */
export const CARD_MEDIA_TYPE = "application/vnd.json-render.card+json";

/**
 * What one Slack message holds. Past these, Slack degrades a card (a second table becomes a code
 * block), so the tool rejects the spec and the model can split or trim it.
 */
export const CARD_LIMITS: CardLimits = {
  chartLabel: 20,
  chartPoints: 20,
  chartSeries: 12,
  chartTitle: 50,
  charts: 2,
  fields: 10,
  tableColumns: 20,
  tableRows: 99,
  tables: 1,
};

/** The blocks one Slack message holds. Slack drops the rest, so the tool rejects a longer card. */
export const CARD_MAX_BLOCKS = 50;

type ComponentName = keyof typeof standardComponentDefinitions;

// Nothing on a card reaches the agent, so cards offer link buttons but no action buttons.
const COMPONENTS = (Object.keys(standardComponentDefinitions) as ComponentName[]).filter(
  (name) => name !== "Button",
);

/** The components a card can use, as json-render's chat catalog defines them. */
export const cardComponents = Object.fromEntries(
  COMPONENTS.map((name) => [name, standardComponentDefinitions[name]]),
);

// One typed variant per component, so the model sees each component's props in the tool's schema.
const elementVariants = COMPONENTS.map((type) => {
  const definition = standardComponentDefinitions[type];
  return z
    .object({
      type: z.literal(type),
      props: definition.props,
      children: z
        .array(z.string())
        .describe(
          definition.slots.length === 0 ? "Always []." : "Keys of child elements, in order.",
        ),
    })
    .describe(definition.description);
});

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
