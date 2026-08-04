export const analyticsEvents = {
  askAiSubmitted: "Submitted docs question",
  docsSearched: "Searched docs",
  gettingStartedOpened: "Opened getting started",
  installerCommandCopied: "Copied installer command",
  installerCommandSelected: "Selected installer command",
  integrationCodeCopied: "Copied integration code",
  integrationDocsOpened: "Opened integration docs",
  integrationFilterSelected: "Selected integration filter",
  integrationOpened: "Opened integration",
  integrationSetupOptionSelected: "Selected integration setup option",
  integrationsSearched: "Searched integrations",
  smartMarkdownNotFound: "Served smart Markdown 404",
  templateFilterSelected: "Selected template filter",
  templateOpened: "Opened template",
  templatesSearched: "Searched templates",
  templateSetupCopied: "Copied template setup prompt",
  templateSourceOpened: "Opened template source",
} as const;

export type AnalyticsEventName = (typeof analyticsEvents)[keyof typeof analyticsEvents];

export type DocsSurface = "docs" | "home" | "integrations" | "other" | "templates";

export const getAnalyticsUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
};

export const normalizeSearchQuery = (query: string): string =>
  query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);

export const getDocsSurface = (value: unknown): DocsSurface => {
  if (typeof value !== "string") return "other";

  let pathname = value;
  try {
    pathname = new URL(value, "https://eve.dev").pathname;
  } catch {
    pathname = value.split("?")[0]?.split("#")[0] ?? value;
  }

  if (pathname === "/" || pathname === "/en") return "home";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "docs";
  if (pathname === "/integrations" || pathname.startsWith("/integrations/")) {
    return "integrations";
  }
  if (pathname === "/templates" || pathname.startsWith("/templates/")) return "templates";
  return "other";
};

export const getCountBucket = (count: number): "0" | "1-5" | "6-10" | "11+" => {
  if (count <= 0) return "0";
  if (count <= 5) return "1-5";
  if (count <= 10) return "6-10";
  return "11+";
};

export const getQueryLengthBucket = (query: string): "1-2" | "3-10" | "11-30" | "31+" => {
  const length = query.trim().length;
  if (length <= 2) return "1-2";
  if (length <= 10) return "3-10";
  if (length <= 30) return "11-30";
  return "31+";
};

export const getResponseOutcome = (
  status: number,
): "accepted" | "client_error" | "server_error" => {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "accepted";
};

export const getMarkdownFormat = (
  pathname: string,
  accept: string | null,
): "accept" | "md" | "mdx" | "unknown" => {
  if (pathname.endsWith(".mdx")) return "mdx";
  if (pathname.endsWith(".md")) return "md";
  if (accept?.toLowerCase().includes("text/markdown")) return "accept";
  return "unknown";
};

export const countMarkdownSuggestions = (body: string): number =>
  body.match(/^- \[[^\]]+\]\([^\n]+\)/gm)?.length ?? 0;
