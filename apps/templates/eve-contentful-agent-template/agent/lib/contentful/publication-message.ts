/**
 * Pure rendering of saved publication scope into Slack preview blocks and notification text.
 *
 * @packageDocumentation
 */

import type { ContentfulPublicationPlan } from "./publication";

type PublicationItem = ContentfulPublicationPlan["items"][number];
const PUBLICATION_CONTEXT =
  "Once a user approves this request, the listed content will be published in Contentful.";
const STATUS_LABELS = {
  archived: "Archived",
  changed: "Changed",
  draft: "Draft",
  published: "Already published",
};

const itemLabel = (item: PublicationItem) => {
  const title = item.title?.replaceAll(/\s+/gu, " ").trim();
  return title ? title.slice(0, 120) : `${item.kind} ${item.id}`;
};

const heading = (text: string) => ({
  elements: [
    { style: { bold: true }, text: `${text}\n`, type: "text" as const },
  ],
  type: "rich_text_section" as const,
});

const itemLink = (item: PublicationItem) => ({
  text: itemLabel(item),
  type: "link" as const,
  url: item.contentfulUrl,
});

const entryList = (items: PublicationItem[]) =>
  items.map((item) => ({
    elements: [
      itemLink(item),
      { text: ` — ${STATUS_LABELS[item.status]}\n`, type: "text" as const },
    ],
    type: "rich_text_section" as const,
  }));

const referenceBlock = (items: PublicationItem[]) => {
  const rows = [
    [
      { text: "Name", type: "raw_text" as const },
      { text: "Status", type: "raw_text" as const },
    ],
    ...items.map((item) => [
      {
        elements: [
          { elements: [itemLink(item)], type: "rich_text_section" as const },
        ],
        type: "rich_text" as const,
      },
      { text: STATUS_LABELS[item.status], type: "raw_text" as const },
    ]),
  ];
  // Count serialized cells conservatively, including URLs and formatting. A
  // table has a 10,000-character / 100-row limit. Keep oversized plans complete
  // in the same container by rendering links and statuses as rich text instead.
  if (rows.length > 100 || JSON.stringify(rows).length > 10_000) {
    return { elements: entryList(items), type: "rich_text" as const };
  }
  return {
    column_settings: [
      { align: "left" as const, is_wrapped: true },
      { align: "right" as const, is_wrapped: false },
    ],
    rows,
    type: "table" as const,
  };
};

/**
 * Render the frozen approval scope without reading Contentful or changing the plan.
 *
 * @param plan - Saved publication plan; only its requested/dependency items are rendered.
 * @returns Slack container/context blocks and literal notification text with requested entry links.
 * @remarks Linked references show status; oversized tables become complete linked lists.
 * The input adapter adds controls and records confirmed delivery. Titles remain structured
 * link text, and notification text neutralizes Slack angle-bracket syntax.
 */
export const formatContentfulPublicationPreview = (
  plan: ContentfulPublicationPlan
) => {
  const requested = plan.items.filter((item) => item.role === "requested");
  const dependencies = plan.items.filter((item) => item.role === "dependency");
  const mainHeading = requested.length === 1 ? "Main Entry" : "Main Entries";
  const context = [
    PUBLICATION_CONTEXT,
    "Publication includes all locales of each listed entry.",
    ...(dependencies.some((item) => item.status === "changed")
      ? ["Updating linked references may affect other pages too."]
      : []),
  ].join(" ");
  const blocks = [
    {
      child_blocks: [
        {
          level: 1,
          text: {
            emoji: false,
            text: "Content Preview",
            type: "plain_text" as const,
          },
          type: "header" as const,
        },
        { type: "divider" as const },
        {
          elements: [
            {
              elements: [
                ...heading(mainHeading).elements,
                ...requested.flatMap((item, index) => [
                  ...(index > 0 ? [{ text: "\n", type: "text" as const }] : []),
                  itemLink(item),
                ]),
                // Slack collapses leading block whitespace; keep this gap
                // between the entry links and heading in the same section.
                ...(dependencies.length > 0
                  ? [
                      { text: "\n\n", type: "text" as const },
                      {
                        style: { bold: true },
                        text: "Linked References",
                        type: "text" as const,
                      },
                    ]
                  : []),
              ],
              type: "rich_text_section" as const,
            },
          ],
          type: "rich_text" as const,
        },
        ...(dependencies.length > 0 ? [referenceBlock(dependencies)] : []),
      ],
      subtitle: {
        emoji: false,
        text: "Contentful",
        type: "plain_text" as const,
      },
      title: {
        emoji: false,
        text: "Contentful Agent",
        type: "plain_text" as const,
      },
      type: "container" as const,
    },
    {
      elements: [{ text: context, type: "plain_text" as const }],
      type: "context" as const,
    },
  ];
  const text = [
    "Contentful Agent",
    "Content Preview",
    mainHeading,
    ...requested.map((item) => `${itemLabel(item)}: ${item.contentfulUrl}`),
    ...(dependencies.length > 0
      ? [
          "Linked References",
          ...dependencies.map(
            (item) =>
              `${itemLabel(item)} — ${STATUS_LABELS[item.status]}: ${item.contentfulUrl}`
          ),
        ]
      : []),
    context,
  ].join("\n");
  return {
    blocks,
    // Keep notification text literal too, including titles containing Slack syntax.
    text: text.replaceAll("<", "‹").replaceAll(">", "›"),
  };
};
