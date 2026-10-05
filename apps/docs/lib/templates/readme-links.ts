const SAFE_ABSOLUTE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

interface MarkdownNode {
  type?: unknown;
  url?: unknown;
  value?: unknown;
  children?: unknown;
  data?: { hProperties?: Record<string, unknown> };
}

export const createResolveReadmeLinksPlugin =
  (sourceRevisionHref: string) =>
  () =>
  (tree: unknown): void => {
    resolveMarkdownLinks(tree, sourceRevisionHref);
  };

export const createReadmeHeadingIdsPlugin =
  () =>
  () =>
  (tree: unknown): void => {
    addHeadingIds(tree);
  };

export const resolveReadmeHref = (
  href: string | undefined,
  sourceRevisionHref: string,
): string | undefined => {
  const sanitizedHref = sanitizeReadmeHref(href);
  if (!sanitizedHref || isAbsoluteHref(sanitizedHref)) {
    return sanitizedHref;
  }
  if (sanitizedHref.startsWith("#")) {
    return `#user-content-${sanitizedHref.slice(1)}`;
  }

  const bases = getGitHubBases(sourceRevisionHref);
  if (!bases) {
    return undefined;
  }

  const base = sanitizedHref.startsWith("/") ? bases.repository : bases.directory;
  return new URL(sanitizedHref.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString();
};

export const sanitizeReadmeHref = (href: string | undefined): string | undefined => {
  if (!href) {
    return undefined;
  }

  const normalized = stripAsciiControlCharacters(href.trim());
  if (!normalized || normalized.startsWith("//")) {
    return undefined;
  }
  if (normalized.startsWith("#")) {
    return normalized;
  }

  const protocolMatch = normalized.match(/^([a-z][a-z\d+.-]*):/i);
  if (!protocolMatch) {
    return normalized;
  }

  try {
    const url = new URL(normalized);
    return SAFE_ABSOLUTE_PROTOCOLS.has(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const isAbsoluteHref = (href: string): boolean =>
  /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//");

const getGitHubBases = (
  sourceRevisionHref: string,
): { directory: string; repository: string } | null => {
  let url: URL;
  try {
    url = new URL(sourceRevisionHref);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") {
    return null;
  }

  const [owner, repo, view, revision] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || view !== "tree" || !revision) {
    return null;
  }

  return {
    directory: url.toString(),
    repository: new URL(`/${owner}/${repo}/tree/${revision}`, url.origin).toString(),
  };
};

const addHeadingIds = (value: unknown): void => {
  const usedSlugs = new Set<string>();
  const visit = (nodeValue: unknown): void => {
    if (!nodeValue || typeof nodeValue !== "object") return;

    const node = nodeValue as MarkdownNode;
    if (typeof node.type === "string" && /^heading$/.test(node.type)) {
      const base = slugHeading(collectText(node));
      let slug = base;
      let suffix = 0;
      while (usedSlugs.has(slug)) slug = `${base}-${++suffix}`;
      usedSlugs.add(slug);
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          id: slug,
        },
      };
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(value);
};

const collectText = (node: MarkdownNode): string => {
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => collectText(child as MarkdownNode)).join("");
};

const slugHeading = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, " ")
    .trim()
    .replace(/ +/g, "-");

const resolveMarkdownLinks = (value: unknown, sourceRevisionHref: string): void => {
  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as MarkdownNode;
  if (node.type === "link" && typeof node.url === "string") {
    node.url = resolveReadmeHref(node.url, sourceRevisionHref);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      resolveMarkdownLinks(child, sourceRevisionHref);
    }
  }
};

const stripAsciiControlCharacters = (value: string): string => {
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f) {
      normalized += character;
    }
  }
  return normalized;
};
