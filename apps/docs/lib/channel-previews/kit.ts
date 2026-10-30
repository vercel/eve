// Palettes, icons, and text parsing for the channel previews. Adapted from
// the template card previews drafted in vercel/eve#5133.

/** Stable 32-bit string hash, so the server and client pick the same person. */
const hashString = (seed: string): number => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
};

export interface PreviewUser {
  name: string;
  /** GitHub username, shown on the GitHub surface. */
  login: string;
  /** GitHub user ID, for a rename-proof avatar URL. */
  githubId: number;
}

/** eve contributors who play the person talking to the agent. */
const PREVIEW_USERS: PreviewUser[] = [
  { name: "barba", login: "AndrewBarba", githubId: 1316152 },
  { name: "Casey Gowrie", login: "ctgowrie", githubId: 6045519 },
  { name: "pankow", login: "benpankow", githubId: 10215173 },
  { name: "owen", login: "OwenKephart", githubId: 22457492 },
  { name: "prha", login: "prha", githubId: 1040172 },
  { name: "chad", login: "chadhietala", githubId: 183799 },
  { name: "rui", login: "ruiconti", githubId: 1834568 },
  { name: "colton", login: "cmpadden", githubId: 5807118 },
  { name: "shar", login: "darafsheh", githubId: 2982650 },
];

export const pickPreviewUser = (seed: string): PreviewUser =>
  PREVIEW_USERS[hashString(seed) % PREVIEW_USERS.length]!;

export const githubAvatarUrl = (user: PreviewUser) =>
  `https://avatars.githubusercontent.com/u/${user.githubId}?s=72&v=4`;

// --- App palettes --------------------------------------------------------

type Palette<Keys extends string> = Record<"light" | "dark", Record<Keys, string>>;

/** Slack's light and dark palette. */
export const SLACK_COLORS: Palette<
  | "bg"
  | "fg"
  | "strong"
  | "border"
  | "hairline"
  | "muted"
  | "link"
  | "codeFg"
  | "codeBg"
  | "mentionBg"
  | "tint"
  | "badgeFg"
> = {
  light: {
    bg: "#ffffff",
    fg: "#1d1c1d",
    strong: "#1d1c1d",
    border: "rgba(29,28,29,0.13)",
    hairline: "rgba(29,28,29,0.13)",
    muted: "#616061",
    link: "#1264a3",
    codeFg: "#e01e5a",
    codeBg: "rgba(29,28,29,0.04)",
    mentionBg: "rgba(29,155,209,0.1)",
    tint: "rgba(29,28,29,0.04)",
    badgeFg: "rgba(29,28,29,0.7)",
  },
  dark: {
    bg: "#1a1d21",
    fg: "#d1d2d3",
    strong: "#f8f8f8",
    border: "#35373b",
    hairline: "rgba(232,232,232,0.13)",
    muted: "#ababad",
    link: "#1d9bd1",
    codeFg: "#e8912d",
    codeBg: "rgba(232,232,232,0.04)",
    mentionBg: "rgba(29,155,209,0.18)",
    tint: "rgba(232,232,232,0.04)",
    badgeFg: "#ababad",
  },
};

/** Primer's light and dark tokens, as github.com computes them. */
export const GITHUB_COLORS: Palette<
  | "bg"
  | "fg"
  | "muted"
  | "border"
  | "mutedBg"
  | "link"
  | "avatarRing"
  | "open"
  | "timeline"
  | "codeBg"
> = {
  light: {
    bg: "#ffffff",
    fg: "#1f2328",
    muted: "#59636e",
    border: "#d1d9e0",
    mutedBg: "#f6f8fa",
    link: "#0969da",
    avatarRing: "#1f232826",
    open: "#1f883d",
    timeline: "#d1d9e0b3",
    codeBg: "#818b981f",
  },
  dark: {
    bg: "#0d1117",
    fg: "#f0f6fc",
    muted: "#9198a1",
    border: "#3d444d",
    mutedBg: "#151b23",
    link: "#4493f8",
    avatarRing: "#ffffff26",
    open: "#238636",
    timeline: "#3d444db3",
    codeBg: "#656c7633",
  },
};

/** iOS Messages, including the liquid-glass controls in its header. */
export const IMESSAGE_COLORS: Palette<
  | "sent"
  | "received"
  | "muted"
  | "avatarTop"
  | "avatarBottom"
  | "avatarRing"
  | "glassBg"
  | "glassDrop"
  | "glassEdge"
  | "glassRing"
> = {
  light: {
    sent: "#0a84ff",
    received: "#e9e9eb",
    muted: "#8e8e93",
    avatarTop: "#a6abb8",
    avatarBottom: "#858994",
    avatarRing: "rgba(0,0,0,0.05)",
    glassBg: "rgba(255,255,255,0.7)",
    glassDrop: "rgba(0,0,0,0.08)",
    glassEdge: "rgba(255,255,255,0.9)",
    glassRing: "rgba(0,0,0,0.06)",
  },
  dark: {
    sent: "#0a84ff",
    received: "#262628",
    muted: "#8e8e93",
    avatarTop: "#a6abb8",
    avatarBottom: "#858994",
    avatarRing: "rgba(255,255,255,0.15)",
    glassBg: "rgba(255,255,255,0.12)",
    glassDrop: "rgba(0,0,0,0.5)",
    glassEdge: "rgba(255,255,255,0.25)",
    glassRing: "rgba(255,255,255,0.08)",
  },
};

/** References to `paletteVars` variables, for inline styles. */
export const paletteVarRefs = <Keys extends string>(prefix: string, palette: Palette<Keys>) =>
  Object.fromEntries(
    (Object.keys(palette.light) as Keys[]).map((key) => [key, `var(--${prefix}-${key})`]),
  ) as Record<Keys, string>;

/**
 * CSS custom properties for a palette, as `light-dark()` pairs, named
 * `--{prefix}-{key}`. The element that sets them also needs a `color-scheme`
 * that follows the site theme.
 */
export const paletteVars = <Keys extends string>(prefix: string, palette: Palette<Keys>) =>
  Object.fromEntries(
    (Object.keys(palette.light) as Keys[]).map((key) => [
      `--${prefix}-${key}`,
      `light-dark(${palette.light[key]}, ${palette.dark[key]})`,
    ]),
  );

// --- Icons ---------------------------------------------------------------

/** Octicons (MIT, github.com/primer/octicons), 16px. */
export const OCTICONS = {
  issueOpened: [
    "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  ],
  pullRequest: [
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  ],
  kebab: [
    "M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  ],
};

// --- Message text --------------------------------------------------------

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  /** A [label](url) link. Only the label renders; the preview is not interactive. */
  | { kind: "link"; text: string }
  | { kind: "mention"; text: string }
  /** A GitHub #123 reference. */
  | { kind: "reference"; text: string };

const SLACK_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+)/;
const GITHUB_TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]*\)|@[\w-]+|#\d+)/;

/**
 * Splits message text into plain runs and the inline markup each app styles:
 * `code`, [label](url), and @mentions, plus #123 references on GitHub.
 */
export const parseMessageText = (text: string, app: "github" | "slack"): TextSegment[] =>
  text
    .split(app === "github" ? GITHUB_TOKEN : SLACK_TOKEN)
    .filter(Boolean)
    .map((part): TextSegment => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        return { kind: "code", text: part.slice(1, -1) };
      }
      if (/^\[[^\]]+\]\([^)]*\)$/.test(part)) {
        return { kind: "link", text: part.slice(1, part.indexOf("]")) };
      }
      if (/^@[\w-]+$/.test(part)) return { kind: "mention", text: part };
      if (app === "github" && /^#\d+$/.test(part)) return { kind: "reference", text: part };
      return { kind: "text", text: part };
    });

/** Table cells that read as numbers, which Slack right-aligns. */
export const isNumericCell = (value: string) => /^[-+$€£]?[\d.,]+[%KMB]?$/.test(value);
