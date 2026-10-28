// Shared data for the template card header (app/[lang]/templates/template-preview.tsx)
// and its OG image port (lib/templates/og-preview.tsx): who plays the user,
// the dot-matrix noise, layout offsets, app palettes, icons, and message
// text parsing. Both renderers read from here, so a visual change is one edit.
// No JSX or Node APIs, so scripts/generate-dot-matrix.mjs can import it too.

/** Stable 32-bit string hash, so server, client, and OG pick the same variant. */
export const hashString = (seed: string): number => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
};

// --- The person talking to the agent -------------------------------------

export interface PreviewUser {
  name: string;
  /** GitHub username, shown on the GitHub surface. */
  login: string;
  /** GitHub user ID, for a rename-proof avatar URL. */
  githubId: number;
}

/** eve contributors who play the person talking to the agent. */
export const PREVIEW_USERS: PreviewUser[] = [
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

/** Stable per agent name. */
export const pickPreviewUser = (seed: string): PreviewUser =>
  PREVIEW_USERS[hashString(seed) % PREVIEW_USERS.length]!;

export const githubAvatarUrl = (user: PreviewUser) =>
  `https://avatars.githubusercontent.com/u/${user.githubId}?s=72&v=4`;

export const SLACK_TIMESTAMP = "10:42 AM";

// --- Dot matrix ----------------------------------------------------------

/** The card's dot-matrix SVGs: 8px between dot centers, wider than any card, h-44. */
export const DOT_MATRIX = { gap: 8, width: 480, height: 176, variants: 4 };

export const dotMatrixVariant = (seed: string) => hashString(seed) % DOT_MATRIX.variants;

const noiseHash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Smooth value noise in [0, 1). */
const noise = (x: number, y: number, seed: number) => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const a = noiseHash(x0, y0, seed);
  const b = noiseHash(x0 + 1, y0, seed);
  const c = noiseHash(x0, y0 + 1, seed);
  const d = noiseHash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
};

/**
 * Opacity of the dot at (`x`, `y`): even dots whose brightness drifts in soft
 * patches, fading out downward over `fadeHeight` (pass `Infinity` for an even
 * field). `scale` stretches the noise for a sparser grid, such as the OG
 * image's 16px one.
 */
export const dotOpacity = ({
  fadeHeight = DOT_MATRIX.height,
  scale = 1,
  variant,
  x,
  y,
}: {
  fadeHeight?: number;
  scale?: number;
  variant: number;
  x: number;
  y: number;
}) => {
  const n = noise(x / (56 * scale), y / (40 * scale), variant * 7919 + 1);
  const falloff = Number.isFinite(fadeHeight) ? clamp01(1.1 - y / (fadeHeight * 0.8)) : 1;
  return (0.12 + 0.88 * n ** 2) * falloff;
};

// --- Layout --------------------------------------------------------------

/**
 * Where the conversation window sits in the card header, in CSS pixels from
 * each edge. Negative values run it off the edge.
 */
export const WINDOW_INSET = { top: 20, right: -12, bottom: -20, left: 24 };
/** Slack and GitHub show a channel or thread header, so their windows start this much higher. */
export const APP_WINDOW_RAISE = 8;
/** The iMessage phone: centered, and taller than the header so it runs off the bottom. */
export const PHONE_FRAME = { top: 12, bottom: -40, width: 256 };
/** Slack and GitHub are laid out at their real desktop metrics, then zoomed down to fit. */
export const SLACK_ZOOM = 0.72;
export const GITHUB_ZOOM = 0.7;
/** The conversation fades out from here (fraction of the header height) toward the title. */
export const PREVIEW_FADE_FROM = 0.7;
export const MAX_PLACEHOLDER_ICONS = 4;
export const SLACK_CHART = { width: 320, height: 36 };

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
  | "green"
  | "button"
  | "unfurl"
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
    green: "#007a5a",
    button: "#007a5a",
    unfurl: "#dddddd",
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
    green: "#2bac76",
    button: "#148567",
    unfurl: "#545454",
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
  | "draft"
  | "timeline"
  | "badgeBg"
  | "labelBg"
  | "labelFg"
  | "labelBorder"
  | "addNumberBg"
  | "addLineBg"
  | "keyword"
  | "number"
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
    draft: "#59636e",
    timeline: "#d1d9e0b3",
    badgeBg: "#f6f8fa",
    labelBg: "#c5def5",
    labelFg: "#000000",
    labelBorder: "transparent",
    addNumberBg: "#aceebb",
    addLineBg: "#dafbe1",
    keyword: "#cf222e",
    number: "#0550ae",
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
    draft: "#656c76",
    timeline: "#3d444db3",
    badgeBg: "#212830",
    labelBg: "#c5def52e",
    labelFg: "#c5def5",
    labelBorder: "#c5def54d",
    addNumberBg: "#3fb9504d",
    addLineBg: "#2ea04326",
    keyword: "#ff7b72",
    number: "#79c0ff",
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

/** References to `paletteVars` variables, for inline styles in the browser. */
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
  pullRequestDraft: [
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  ],
  tag: [
    "M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
  ],
  kebab: [
    "M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  ],
};

/** Lucide icons (ISC, lucide.dev) the previews use, as 24px stroke paths. */
export const LUCIDE = {
  terminal: ["M12 19h8", "m4 17 6-6-6-6"],
  wrench: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",
  ],
  chevronRight: ["m9 18 6-6-6-6"],
  mic: [
    "M12 19v3",
    "M19 10v2a7 7 0 0 1-14 0v-2",
    "M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z",
  ],
  phoneOff: [
    "M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272",
    "M22 2 2 22",
    "M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473",
  ],
  braces: [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ],
};

// --- Message text --------------------------------------------------------

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  /** A [label](url) link. The URL is not rendered; the card itself is the link. */
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

const DIFF_TOKEN = /(\b(?:const|let|var|return|await|if|new|function)\b|\b\d+\b)/;

/** Splits a one-line code sample into the few token kinds GitHub colors. */
export const parseDiffCode = (code: string) =>
  code
    .split(DIFF_TOKEN)
    .filter(Boolean)
    .map((text) => ({
      kind: /^\d+$/.test(text)
        ? ("number" as const)
        : DIFF_TOKEN.test(text)
          ? ("keyword" as const)
          : ("text" as const),
      text,
    }));

/** Table cells that read as numbers, which Slack right-aligns. */
export const isNumericCell = (value: string) => /^[-+$€£]?[\d.,]+[%KMB]?$/.test(value);
