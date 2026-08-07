const SAFE_ABSOLUTE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const resolveReadmeHref = (
  href: string | undefined,
  sourceRevisionHref: string,
): string | undefined => {
  const sanitizedHref = sanitizeReadmeHref(href);
  if (!sanitizedHref || sanitizedHref.startsWith("#") || isAbsoluteHref(sanitizedHref)) {
    return sanitizedHref;
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
