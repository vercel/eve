import { createSource, type FumadocsCollection } from "@vercel/geistdocs/source";
import { config } from "@/lib/geistdocs/config";
import { integrationSearchText } from "./discovery";
import { integrations } from "./data";

const structuredData = (content: string) => ({
  headings: [],
  contents: [{ heading: undefined, content }],
});

const integrationFiles = [
  {
    type: "meta" as const,
    path: "meta.json",
    data: {
      title: "Integrations",
      root: true,
    },
  },
  {
    type: "page" as const,
    path: "index.md",
    slugs: [],
    data: {
      title: "Integrations",
      description:
        "Browse every third-party service eve connects to, including channels and connections.",
      excludeFrom: ["search" as const],
      type: "directory",
      structuredData: structuredData("Integrations for eve."),
      getText: async () => "Integrations for eve.",
    },
  },
  ...integrations.map((integration) => {
    return {
      type: "page" as const,
      path: `${integration.slug}.md`,
      slugs: [integration.slug],
      data: {
        title: integration.name,
        description: integration.tagline,
        type: integration.type,
        keywords: integration.keywords,
        structuredData: structuredData(integrationSearchText(integration)),
        getText: async () => integration.tagline,
      },
    };
  }),
];

const integrationDocs: FumadocsCollection = {
  toFumadocsSource: () => ({ files: integrationFiles }),
};

export const integrationSource = createSource({
  baseUrl: "/integrations",
  config,
  docs: integrationDocs,
  id: "integrations",
  label: "Integrations",
});
