// The OG image side of the template card header: next/og colors, fonts, and
// images for the shared PreviewScene, the dot field, and scaling the
// card-size scene up to OG pixels.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Children,
  type CSSProperties,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { TemplateManifestEntry } from "./manifest";
import {
  clamp01,
  DOT_MATRIX,
  dotMatrixVariant,
  dotOpacity,
  GITHUB_COLORS,
  githubAvatarUrl,
  IMESSAGE_COLORS,
  pickPreviewUser,
  SLACK_COLORS,
  smoothstep,
  WINDOW_INSET,
} from "./preview-kit";
import { type Inset, PreviewScene, type SceneAssets, type SceneTheme } from "./preview-scene";

/** Dark mode, with Geist tokens resolved to sRGB since next/og has no CSS variables. */
export const ogTheme: SceneTheme = {
  target: "og",
  colors: {
    background100: "#000000",
    background100Clear: "#00000000",
    gray700: "#8f8f8f",
    gray800: "#7d7d7d",
    gray900: "#a1a1a1",
    gray1000: "#ededed",
    grayAlpha400: "rgba(255,255,255,0.14)",
    red800: "#e5484d",
    shadowSmall: "0px 2px 2px 0px rgba(0,0,0,0.04)",
  },
  slack: SLACK_COLORS.dark,
  github: GITHUB_COLORS.dark,
  imessage: IMESSAGE_COLORS.dark,
  // Registered with ImageResponse in og-image.tsx.
  fonts: {
    sans: "Geist",
    lato: "Lato",
    monaSans: "Mona Sans",
    slackCode: "Geist Mono",
    mono: "Geist Mono",
  },
};

/**
 * The card's dot matrix as an SVG data URI. `fade` is the height over which
 * dots fade out downward; pass `Infinity` for an even field.
 */
export const dotMatrixSrc = ({
  color,
  fade = DOT_MATRIX.height,
  fadeLeft,
  gap = DOT_MATRIX.gap,
  height,
  seed,
  strength = 1,
  width,
}: {
  color: string;
  fade?: number;
  /** Fade dots in from the left edge until this x. */
  fadeLeft?: number;
  gap?: number;
  height: number;
  seed: string;
  strength?: number;
  width: number;
}) => {
  const variant = dotMatrixVariant(seed);
  const dots: string[] = [];
  for (let y = gap / 2; y < height; y += gap) {
    for (let x = gap / 2; x < width; x += gap) {
      const leftFalloff = fadeLeft ? smoothstep(clamp01(x / fadeLeft)) : 1;
      const opacity =
        dotOpacity({ fadeHeight: fade, scale: gap / DOT_MATRIX.gap, variant, x, y }) *
        leftFalloff *
        strength;
      if (opacity < 0.02) continue;
      dots.push(
        `<circle cx="${x}" cy="${y}" r="${gap / 8}" fill-opacity="${+opacity.toFixed(2)}"/>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" fill="${color}">${dots.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

const toDataUri = (data: Buffer, type: string) => `data:${type};base64,${data.toString("base64")}`;

const loadPublicImage = async (path: string) => {
  const data = await readFile(join(process.cwd(), "public", path));
  return toDataUri(data, path.endsWith(".svg") ? "image/svg+xml" : "image/png");
};

const loadRemoteImage = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "image/png";
    return toDataUri(Buffer.from(await response.arrayBuffer()), type);
  } catch {
    // A missing avatar falls back to an empty square rather than failing the image.
    return undefined;
  }
};

/** The scene's images as data URIs, since next/og can't load site-relative paths. */
export const loadOgPreviewAssets = async (
  template: TemplateManifestEntry,
): Promise<SceneAssets> => {
  const user = pickPreviewUser(template.preview?.agent ?? template.title);
  const [agentIcon, userAvatar] = await Promise.all([
    template.preview?.icon ? loadPublicImage(template.preview.icon) : undefined,
    template.preview?.surface === "slack" || template.preview?.surface === "github"
      ? loadRemoteImage(githubAvatarUrl(user))
      : undefined,
  ]);
  return { agentIcon, userAvatar, userLogin: user.login, userName: user.name };
};

/**
 * The card header's foreground at card scale (`width` × `height` CSS pixels).
 * Size it for the OG canvas with `scaleTree`.
 */
export const HeaderScene = ({
  assets,
  height,
  inset = WINDOW_INSET,
  template,
  visibleHeight,
  width,
}: {
  assets: SceneAssets;
  height: number;
  inset?: Inset;
  template: TemplateManifestEntry;
  /**
   * Height of the part of the scene that is not faded out. The Voice
   * template's call controls pin to it, as they pin to the card's bottom edge.
   */
  visibleHeight: number;
  width: number;
}) => (
  <div style={{ display: "flex", height, position: "relative", width }}>
    <PreviewScene
      assets={assets}
      footerBottom={height - inset.bottom - visibleHeight}
      inset={inset}
      template={template}
      theme={ogTheme}
    />
  </div>
);

const UNITLESS = new Set([
  "flex",
  "flexGrow",
  "flexShrink",
  "fontWeight",
  "lineHeight",
  "opacity",
  "zoom",
]);
/** Browser-only styles the shared scene uses that next/og rejects or can't draw. */
const BROWSER_ONLY = new Set([
  "backdropFilter",
  "fontVariantNumeric",
  "overflowWrap",
  "textUnderlineOffset",
  "verticalAlign",
  "zIndex",
]);
const OG_DISPLAY = new Set(["flex", "none", "contents"]);
const PX = /(-?\d*\.?\d+)px/g;

const scaleValue = (key: string, value: unknown, factor: number): unknown => {
  if (typeof value === "number") return UNITLESS.has(key) ? value : value * factor;
  if (typeof value === "string" && !key.startsWith("mask") && !key.startsWith("background")) {
    return value.replace(PX, (_, n: string) => `${Number(n) * factor}px`);
  }
  return value;
};

type ScalableProps = {
  children?: ReactNode;
  height?: number | string;
  style?: CSSProperties & { zoom?: number };
  width?: number | string;
};

/**
 * Prepares a card-scale tree for next/og: multiplies every length by
 * `factor`, applies `zoom` (which next/og lacks) by scaling that subtree
 * further, and drops browser-only styles. next/og clips `overflow` and
 * `mask-image` in untransformed coordinates, so a CSS `transform: scale()`
 * would cut the scaled content off; scaling the lengths keeps clipping right.
 */
export const scaleTree = (node: ReactNode, factor: number): ReactNode => {
  if (Array.isArray(node)) return node.map((child) => scaleTree(child, factor));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<ScalableProps>;
  // next/og would lay a fragment out as its own flex row; splice its children into the parent.
  if (element.type === Fragment) return scaleTree(Children.toArray(element.props.children), factor);
  if (typeof element.type === "function") {
    const component = element.type as (props: ScalableProps) => ReactNode;
    return scaleTree(component(element.props), factor);
  }
  const { children, style, ...props } = element.props;
  const zoom = style?.zoom ?? 1;
  const nextProps: ScalableProps & Record<string, unknown> = { ...props };
  if (style) {
    const scaled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
      if (value === undefined || key === "zoom" || BROWSER_ONLY.has(key)) continue;
      if (key === "display" && !OG_DISPLAY.has(String(value))) continue;
      // Lengths inside a zoomed box use the zoomed factor, including its own.
      scaled[key] = scaleValue(key, value, factor * zoom);
    }
    nextProps.style = scaled as ScalableProps["style"];
  }
  // Only the root svg's size scales; children live in its viewBox.
  if (element.type === "svg" || element.type === "img") {
    if (typeof props.width === "number") nextProps.width = props.width * factor;
    if (typeof props.height === "number") nextProps.height = props.height * factor;
    return cloneElement(element, nextProps, children);
  }
  return cloneElement(
    element,
    nextProps,
    ...Children.toArray(children).flatMap((child) => scaleTree(child, factor * zoom)),
  );
};
