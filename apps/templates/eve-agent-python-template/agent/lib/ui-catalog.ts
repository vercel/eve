import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

/**
 * An absolute https URL. Images load as soon as they render, so an image URL
 * from untrusted content could leak data to its host; requiring https at least
 * rules out `javascript:`, `data:`, and plain-text URLs.
 */
const httpsUrl = z
  .url({ error: "Must be an absolute https URL.", protocol: /^https$/ })
  // zod accepts `https:/path`, which a browser resolves against the page's own origin.
  .refine((value) => /^https:\/\//iu.test(value), "Must be an absolute https URL.")
  .describe("An absolute https URL.");

/** An absolute http or https URL, for links the person chooses to open. */
const webUrl = z
  .url({
    error: "Must be an absolute http or https URL.",
    protocol: /^https?$/,
  })
  .describe("An absolute http or https URL.");

/**
 * Checks an image URL at render time, matching the catalog's rule.
 *
 * @param value - The URL to check.
 * @returns Whether the URL is an absolute https URL.
 */
export function isSafeImageUrl(value: string): boolean {
  return httpsUrl.safeParse(value).success;
}

/**
 * Checks a link URL at render time, matching the catalog's rule.
 *
 * @param value - The URL to check.
 * @returns Whether the URL is an absolute http or https URL.
 */
export function isSafeLinkUrl(value: string): boolean {
  return webUrl.safeParse(value).success;
}

/**
 * Components the agent may use in `render_ui` specs. The agent's tool and the
 * web chat's renderer share this catalog, so a spec that validates here renders
 * there.
 */
export const uiCatalog = defineCatalog(schema, {
  components: {
    Accordion: shadcnComponentDefinitions.Accordion,
    Alert: shadcnComponentDefinitions.Alert,
    Avatar: {
      ...shadcnComponentDefinitions.Avatar,
      props: z.object({
        name: z.string(),
        size: z.enum(["sm", "md", "lg"]).nullable(),
        src: httpsUrl.nullable(),
      }),
    },
    Badge: shadcnComponentDefinitions.Badge,
    Card: shadcnComponentDefinitions.Card,
    CardRow: {
      description:
        "A horizontally scrolling row that shows two children at a time. Use it for a list of ResultCards.",
      props: z.object({}),
      slots: ["default"],
    },
    Grid: shadcnComponentDefinitions.Grid,
    Heading: shadcnComponentDefinitions.Heading,
    Image: {
      description:
        "A real image with optional caption. Only use an image URL you actually found.",
      props: z.object({
        alt: z.string(),
        caption: z.string().nullable(),
        src: httpsUrl,
      }),
    },
    KeyValue: {
      description:
        "Label and value rows for details such as opening hours, specs, or contact info.",
      props: z.object({
        items: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .min(1),
      }),
    },
    Link: {
      description:
        "A text link to a page you actually found. Opens in a new tab.",
      props: z.object({
        href: webUrl,
        label: z.string(),
      }),
    },
    Metric: {
      description:
        "A key number for dashboards: a short label, the value, and an optional change line with its trend. Lay several out in a Grid.",
      props: z.object({
        change: z.string().nullable(),
        label: z.string(),
        trend: z.enum(["up", "down", "neutral"]).nullable(),
        value: z.string(),
      }),
    },
    Progress: {
      description:
        "A progress bar showing value out of max, which defaults to 100. Add an optional label above it.",
      props: z.object({
        label: z.string().nullable(),
        max: z.number().nullable(),
        value: z.number(),
      }),
    },
    ResultCard: {
      description:
        "A result such as a restaurant, product, place, or article: optional image, title, subtitle, short description, and link. Always place ResultCards inside a CardRow. Only pass an imageUrl or url you actually found.",
      props: z.object({
        description: z.string().nullable(),
        imageUrl: httpsUrl.nullable(),
        subtitle: z
          .string()
          .nullable()
          .describe(
            "One short line of key facts, such as the suburb or price."
          ),
        title: z.string(),
        url: webUrl.nullable(),
      }),
    },
    Separator: shadcnComponentDefinitions.Separator,
    Stack: shadcnComponentDefinitions.Stack,
    Steps: {
      description:
        "An ordered sequence such as an itinerary, instructions, or a timeline. Each step has a title, optional detail, and optional meta such as a time or date.",
      props: z.object({
        items: z
          .array(
            z.object({
              description: z.string().nullable(),
              meta: z.string().nullable(),
              title: z.string(),
            })
          )
          .min(1),
      }),
    },
    Table: shadcnComponentDefinitions.Table,
    Text: shadcnComponentDefinitions.Text,
  },
  actions: {},
});

const components: Readonly<
  Record<string, { readonly props: z.ZodType; readonly slots?: string[] }>
> = uiCatalog.data.components;

/**
 * The catalog's spec schema, tightened so each element's props must match its
 * component and every ResultCard sits in a CardRow. The catalog alone checks
 * the tree but not individual props.
 */
export const uiSpecSchema = uiCatalog.zodSchema().superRefine((spec, ctx) => {
  const inCardRow = new Set(
    Object.values(spec.elements).flatMap((element) =>
      element.type === "CardRow" ? (element.children ?? []) : []
    )
  );
  for (const [key, element] of Object.entries(spec.elements)) {
    if (element.type === "ResultCard" && !inCardRow.has(key)) {
      ctx.addIssue({
        code: "custom",
        message: "ResultCard must be a child of a CardRow.",
        path: ["elements", key],
      });
    }
    const result = components[element.type]?.props.safeParse(element.props);
    for (const issue of result?.error?.issues ?? []) {
      ctx.addIssue({
        code: "custom",
        message: `${element.type}: ${issue.message}`,
        path: ["elements", key, "props", ...issue.path],
      });
    }
  }
});

/** Component names that accept children. */
export const containerComponents = Object.entries(components)
  .filter(([, component]) => component.slots !== undefined)
  .map(([name]) => name);

/**
 * Describes one component's props for the tool description.
 *
 * @param name - The component name.
 * @returns The component's props as compact JSON Schema.
 */
export function describeComponentProps(name: string): string {
  const component = components[name];
  return component === undefined
    ? "{}"
    : JSON.stringify({
        ...z.toJSONSchema(component.props),
        $schema: undefined,
      });
}
