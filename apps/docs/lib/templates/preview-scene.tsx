// The template card header's foreground: a sample conversation in the style
// of its surface, or the eve-plus-integrations placeholder. One component
// renders both the gallery card (in the browser) and the OG image (in
// next/og), so it sticks to the CSS next/og supports: inline styles, flexbox,
// and absolute positioning. Where the browser can do more, `theme.target`
// switches to it: real inline text flow, and a blur behind the iMessage glass.
import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import {
  type CSSProperties,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  grayscaleIntegrationIcons,
  integrationIcons,
} from "@/app/[lang]/templates/integration-icons";
import { resolveLogo } from "../og-logo";
import type {
  TemplateIntegration,
  TemplateManifestEntry,
  TemplatePreview,
  TemplatePreviewAttachment,
  TemplatePreviewMessage,
  TemplatePreviewThread,
} from "./manifest";
import {
  APP_WINDOW_RAISE,
  type GITHUB_COLORS,
  GITHUB_ZOOM,
  type IMESSAGE_COLORS,
  isNumericCell,
  LUCIDE,
  MAX_PLACEHOLDER_ICONS,
  OCTICONS,
  PHONE_FRAME,
  parseDiffCode,
  parseMessageText,
  type SLACK_COLORS,
  SLACK_CHART,
  SLACK_TIMESTAMP,
  SLACK_ZOOM,
  type TextSegment,
  WINDOW_INSET,
} from "./preview-kit";

/** Colors, fonts, and capabilities of the place the scene renders into. */
export interface SceneTheme {
  /** `dom` for the gallery card, `og` for next/og. */
  target: "dom" | "og";
  /** Geist tokens. */
  colors: {
    background100: string;
    /** Fully transparent `background100`, for gradients. */
    background100Clear: string;
    gray700: string;
    gray800: string;
    gray900: string;
    gray1000: string;
    grayAlpha400: string;
    red800: string;
    /** Geist's `shadow-sm`. */
    shadowSmall: string;
  };
  slack: (typeof SLACK_COLORS)["light"];
  github: (typeof GITHUB_COLORS)["light"];
  imessage: (typeof IMESSAGE_COLORS)["light"];
  fonts: {
    sans: string;
    /** Slack's UI typeface. */
    lato: string;
    /** GitHub's UI typeface. */
    monaSans: string;
    /** Slack's inline code. */
    slackCode: string;
    /** GitHub's code. */
    mono: string;
  };
}

/** Images and the person talking to the agent, resolved for the target. */
export interface SceneAssets {
  agentIcon?: string;
  userAvatar?: string;
  userName: string;
  userLogin: string;
}

export type Inset = typeof WINDOW_INSET;

export type SceneTemplate = Pick<TemplateManifestEntry, "integrations" | "preview" | "title">;

interface SceneProps {
  assets: SceneAssets;
  template: SceneTemplate;
  theme: SceneTheme;
  /** Window inset from the scene edges. Defaults to the card's. */
  inset?: Inset;
  /** Distance from the window's bottom edge to the Voice call controls. Defaults to the card's. */
  footerBottom?: number;
}

/** The scene fills its positioned parent. */
export const PreviewScene = ({
  assets,
  footerBottom = -WINDOW_INSET.bottom,
  inset = WINDOW_INSET,
  template,
  theme,
}: SceneProps) => {
  const preview = template.preview;
  if (!preview) return <Placeholder integrations={template.integrations} theme={theme} />;
  const agent = preview.agent ?? template.title;
  const props = { agent, assets, preview, theme };
  switch (preview.surface) {
    case "github":
      return <GitHub {...props} inset={raise(inset)} />;
    case "imessage":
      return <IMessage {...props} />;
    case "slack":
      return <Slack {...props} inset={raise(inset)} />;
    default:
      return (
        <WebWindow
          address={preview.context}
          footerBottom={footerBottom}
          inset={inset}
          messages={preview.messages}
          theme={theme}
          voice={preview.surface === "voice"}
        />
      );
  }
};

/** Slack and GitHub windows start higher, to fit their channel or thread header. */
const raise = (inset: Inset): Inset => ({ ...inset, top: inset.top - APP_WINDOW_RAISE });

interface SurfaceProps {
  agent: string;
  assets: SceneAssets;
  preview: TemplatePreview;
  theme: SceneTheme;
}

// --- Shared pieces -------------------------------------------------------

const flex = (style: CSSProperties = {}): CSSProperties => ({ display: "flex", ...style });

/** A window: hairline Geist border, rounded corners, clipped content. */
const windowStyle = (
  theme: SceneTheme,
  position: CSSProperties,
  background: string,
): CSSProperties => ({
  ...position,
  backgroundColor: background,
  border: `1px solid ${theme.colors.grayAlpha400}`,
  borderRadius: 8,
  boxShadow: theme.colors.shadowSmall,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "absolute",
});

type Run = string | { text: string; style?: CSSProperties; whole?: boolean } | ReactElement;

/**
 * A paragraph of mixed text and inline elements. The browser lays it out as
 * real inline text. next/og has no inline formatting context, so there it is
 * a wrapping flex row, word by word; `whole` runs (code, mentions) stay
 * unbroken.
 */
const Paragraph = ({
  runs,
  style,
  theme,
}: {
  runs: Run[];
  style?: CSSProperties;
  theme: SceneTheme;
}) => {
  if (theme.target === "dom") {
    return (
      <p style={{ overflowWrap: "break-word", ...style }}>
        {runs.map((run, index) => {
          if (typeof run === "string" || isValidElement(run)) return withKey(run, index);
          return run.style ? (
            <span key={`${index}${run.text}`} style={run.style}>
              {run.text}
            </span>
          ) : (
            run.text
          );
        })}
      </p>
    );
  }
  const items: { node: ReactNode; gap: boolean }[] = [];
  const addWords = (text: string, style?: CSSProperties) => {
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        const last = items.at(-1);
        if (last) last.gap = true;
      } else {
        items.push({ gap: false, node: <div style={flex(style)}>{piece}</div> });
      }
    }
  };
  for (const run of runs) {
    if (typeof run === "string") addWords(run);
    else if (isValidElement(run)) items.push({ gap: false, node: run });
    else if (run.whole)
      items.push({ gap: false, node: <div style={flex(run.style)}>{run.text}</div> });
    else addWords(run.text, run.style);
  }
  return (
    // In a flex row, the paragraph shrinks and wraps rather than overflowing.
    <div style={flex({ flexShrink: 1, flexWrap: "wrap", minWidth: 0, ...style })}>
      {items.map((item, index) => (
        <div key={index} style={flex({ marginRight: item.gap ? "0.27em" : 0 })}>
          {item.node}
        </div>
      ))}
    </div>
  );
};

const withKey = (node: ReactNode, key: number) =>
  isValidElement(node) ? cloneElement(node, { key }) : node;

/** A Lucide icon as plain SVG, since next/og can't render lucide-react's components. */
const LucideIcon = ({
  color = "currentColor",
  paths,
  size,
  style,
}: {
  color?: string;
  paths: string[];
  size: number;
  style?: CSSProperties;
}) => (
  <svg
    fill="none"
    height={size}
    stroke={color}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    style={{ flexShrink: 0, ...style }}
    viewBox="0 0 24 24"
    width={size}
  >
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

const Octicon = ({
  color = "currentColor",
  paths,
  style,
}: {
  color?: string;
  paths: string[];
  style?: CSSProperties;
}) => (
  <svg fill={color} height={16} style={{ flexShrink: 0, ...style }} viewBox="0 0 16 16" width={16}>
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

const EveLogo = ({ height }: { height: number }) => (
  <div style={flex()}>{resolveLogo(<LogoEveSvg height={height} />)}</div>
);

/**
 * Sizes a logo to fit a `size` square at its own aspect ratio. next/og
 * stretches an SVG to its width and height, ignoring `preserveAspectRatio`.
 */
const fitLogo = (node: ReactNode, size: number): ReactNode => {
  if (!isValidElement<{ viewBox?: string }>(node)) return node;
  const [, , width = 1, height = 1] = (node.props.viewBox ?? "").split(/[\s,]+/).map(Number);
  const aspect = width / height || 1;
  return cloneElement(node as ReactElement<{ height?: number; width?: number }>, {
    height: aspect >= 1 ? size / aspect : size,
    width: aspect >= 1 ? size : size * aspect,
  });
};

const IntegrationIcon = ({
  grayscale = false,
  integration,
  size,
}: {
  /** Use the icon set meant for grayscale, like the placeholder tiles. */
  grayscale?: boolean;
  integration: TemplateIntegration;
  size: number;
}) => {
  // Lucide icons read React context, which next/og can't provide, so draw this one directly.
  if (integration === "HTTP API") return <LucideIcon paths={LUCIDE.braces} size={size} />;
  const Icon = (grayscale ? grayscaleIntegrationIcons : integrationIcons)[integration];
  return <div style={flex()}>{fitLogo(resolveLogo(<Icon />), size)}</div>;
};

/** The template's own icon when it has one, otherwise the eve logo on `fallback`. */
const AgentIcon = ({
  assets,
  fallback,
  logoHeight,
  size,
  style,
}: {
  assets: SceneAssets;
  /** Background and logo color behind the eve logo. */
  fallback: { background: string; color: string };
  logoHeight: number;
  size: number;
  style?: CSSProperties;
}) =>
  assets.agentIcon ? (
    // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar; next/og only renders img
    <img
      alt=""
      height={size}
      src={assets.agentIcon}
      style={{ flexShrink: 0, height: size, objectFit: "cover", width: size, ...style }}
      width={size}
    />
  ) : (
    <div
      style={flex({
        alignItems: "center",
        ...(fallback.background.includes("gradient(")
          ? { backgroundImage: fallback.background }
          : { backgroundColor: fallback.background }),
        color: fallback.color,
        flexShrink: 0,
        height: size,
        justifyContent: "center",
        width: size,
        ...style,
      })}
    >
      <EveLogo height={logoHeight} />
    </div>
  );

const UserAvatar = ({
  assets,
  size,
  style,
}: {
  assets: SceneAssets;
  size: number;
  style?: CSSProperties;
}) =>
  assets.userAvatar ? (
    // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar; next/og only renders img
    <img
      alt=""
      height={size}
      src={assets.userAvatar}
      style={{ flexShrink: 0, height: size, objectFit: "cover", width: size, ...style }}
      width={size}
    />
  ) : (
    <div style={{ flexShrink: 0, height: size, width: size, ...style }} />
  );

// --- Web chat and voice --------------------------------------------------

const WebWindow = ({
  address,
  footerBottom,
  inset,
  messages,
  theme,
  voice,
}: {
  address?: string;
  footerBottom: number;
  inset: Inset;
  messages: TemplatePreviewMessage[];
  theme: SceneTheme;
  voice: boolean;
}) => {
  const { colors } = theme;
  return (
    <div
      style={{
        ...windowStyle(theme, inset, colors.background100),
        color: colors.gray1000,
        fontFamily: theme.fonts.sans,
        fontSize: 11.5,
        lineHeight: 1.35,
      }}
    >
      <div
        style={flex({
          alignItems: "center",
          borderBottom: `1px solid ${colors.grayAlpha400}`,
          color: colors.gray800,
          flexShrink: 0,
          gap: 6,
          height: 28,
          padding: "0 12px",
        })}
      >
        {[0, 1, 2].map((dot) => (
          <div
            key={dot}
            style={{
              backgroundColor: colors.grayAlpha400,
              borderRadius: 9999,
              height: 6,
              width: 6,
            }}
          />
        ))}
        {address ? <div style={{ fontSize: 10.5, marginLeft: 8 }}>{address}</div> : null}
      </div>
      <div style={flex({ flexDirection: "column", gap: 8, padding: "10px 12px" })}>
        {messages.map((message) =>
          message.from === "user" ? (
            <div
              key={message.text}
              style={flex({
                alignSelf: "flex-end",
                backgroundColor: colors.gray1000,
                borderRadius: 12,
                color: colors.background100,
                maxWidth: "85%",
                padding: "6px 10px",
              })}
            >
              {message.text}
            </div>
          ) : (
            <div key={message.text} style={flex({ flexDirection: "column", gap: 4 })}>
              {message.tools?.map((tool) => (
                <div
                  key={tool}
                  style={flex({ alignItems: "center", color: colors.gray900, gap: 6 })}
                >
                  <LucideIcon paths={tool === "bash" ? LUCIDE.terminal : LUCIDE.wrench} size={12} />
                  <div>{tool}</div>
                  <LucideIcon paths={LUCIDE.chevronRight} size={10} />
                </div>
              ))}
              <div style={flex()}>{message.text}</div>
            </div>
          ),
        )}
      </div>
      {voice ? (
        // The in-call controls, pinned to the visible bottom of the window.
        <div
          style={flex({
            alignItems: "center",
            backgroundImage: `linear-gradient(to top, ${colors.background100} 60%, ${colors.background100Clear})`,
            bottom: footerBottom,
            gap: 6,
            justifyContent: "center",
            left: 0,
            padding: "16px 0 8px",
            position: "absolute",
            right: 0,
          })}
        >
          <div
            style={flex({
              alignItems: "center",
              backgroundColor: colors.background100,
              border: `1px solid ${colors.grayAlpha400}`,
              borderRadius: 6,
              height: 24,
              justifyContent: "center",
              width: 24,
            })}
          >
            <LucideIcon paths={LUCIDE.mic} size={12} />
          </div>
          <div
            style={flex({
              alignItems: "center",
              backgroundColor: colors.red800,
              borderRadius: 6,
              color: "white",
              fontSize: 10.5,
              fontWeight: 500,
              gap: 4,
              height: 24,
              padding: "0 8px",
            })}
          >
            <LucideIcon paths={LUCIDE.phoneOff} size={12} />
            End call
          </div>
        </div>
      ) : null}
    </div>
  );
};

// --- Slack ---------------------------------------------------------------

/**
 * Laid out at Slack's real desktop metrics (Lato 15/22, 36px avatars, 8px
 * 20px message gutters, 49px channel header) and Slack's own light and dark
 * palette, then zoomed down as a whole so the proportions match Slack at any
 * card size.
 */
const Slack = ({ agent, assets, inset, preview, theme }: SurfaceProps & { inset: Inset }) => {
  const { slack } = theme;
  const { messages } = preview;
  return (
    <div style={windowStyle(theme, inset, slack.bg)}>
      <div
        style={flex({
          color: slack.fg,
          flexDirection: "column",
          fontFamily: theme.fonts.lato,
          fontSize: 15,
          left: 0,
          lineHeight: 1.46668,
          position: "absolute",
          right: 0,
          top: 0,
          zoom: SLACK_ZOOM,
        })}
      >
        <div
          style={flex({
            alignItems: "center",
            borderBottom: `1px solid ${slack.border}`,
            color: slack.strong,
            fontSize: 18,
            fontWeight: 900,
            height: 49,
            lineHeight: 1,
            padding: "0 20px",
          })}
        >
          <div style={{ fontWeight: 700, marginRight: 4 }}>#</div>
          <div>{preview.context ?? "general"}</div>
        </div>
        <div style={flex({ flexDirection: "column", paddingTop: 8 })}>
          {messages.map((message, index) => {
            const isAgent = message.from === "agent";
            const body = (
              <>
                <SlackText text={message.text} theme={theme} />
                {message.attachment ? (
                  <SlackAttachment attachment={message.attachment} theme={theme} />
                ) : null}
              </>
            );
            // Slack folds a follow-up from the same sender under the first message's header.
            if (messages[index - 1]?.from === message.from) {
              return (
                <div
                  key={message.text}
                  style={flex({
                    flexDirection: "column",
                    marginTop: -8,
                    padding: "2px 20px 2px 64px",
                  })}
                >
                  {body}
                </div>
              );
            }
            return (
              <div key={message.text} style={flex({ gap: 8, padding: "8px 20px" })}>
                {isAgent ? (
                  <AgentIcon
                    assets={assets}
                    fallback={{
                      background: theme.colors.gray1000,
                      color: theme.colors.background100,
                    }}
                    logoHeight={11}
                    size={36}
                    style={{ borderRadius: 8 }}
                  />
                ) : (
                  <UserAvatar
                    assets={assets}
                    size={36}
                    style={{ backgroundColor: slack.hairline, borderRadius: 8 }}
                  />
                )}
                <div style={flex({ flex: 1, flexDirection: "column", minWidth: 0 })}>
                  <div style={flex({ alignItems: "baseline", gap: 4 })}>
                    <div style={{ color: slack.strong, fontWeight: 900 }}>
                      {isAgent ? agent : assets.userName}
                    </div>
                    {isAgent ? (
                      <div
                        style={{
                          alignSelf: "center",
                          backgroundColor: slack.hairline,
                          borderRadius: 2,
                          color: slack.badgeFg,
                          fontSize: 10,
                          fontWeight: 700,
                          lineHeight: "14px",
                          marginLeft: 4,
                          padding: "1px 3px",
                        }}
                      >
                        APP
                      </div>
                    ) : null}
                    <div style={{ color: slack.muted, fontSize: 12, marginLeft: 4 }}>
                      {SLACK_TIMESTAMP}
                    </div>
                  </div>
                  {body}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Message text with Slack's inline code, link, and user mention styles. */
const SlackText = ({ text, theme }: { text: string; theme: SceneTheme }) => {
  const { slack } = theme;
  const styleOf = (segment: TextSegment): Run => {
    switch (segment.kind) {
      case "code":
        return {
          style: {
            backgroundColor: slack.codeBg,
            border: `1px solid ${slack.hairline}`,
            borderRadius: 3,
            color: slack.codeFg,
            fontFamily: theme.fonts.slackCode,
            fontSize: 12,
            padding: "2px 3px 1px",
          },
          text: segment.text,
          whole: true,
        };
      case "link":
        return { style: { color: slack.link }, text: segment.text };
      case "mention":
        return {
          style: {
            backgroundColor: slack.mentionBg,
            borderRadius: 3,
            color: slack.link,
            padding: "0 2px",
          },
          text: segment.text,
          whole: true,
        };
      default:
        return segment.text;
    }
  };
  return <Paragraph runs={parseMessageText(text, "slack").map(styleOf)} theme={theme} />;
};

const SlackAttachment = ({
  attachment,
  theme,
}: {
  attachment: TemplatePreviewAttachment;
  theme: SceneTheme;
}) => {
  const { slack } = theme;
  const card: CSSProperties = flex({
    border: `1px solid ${slack.border}`,
    borderRadius: 8,
    flexDirection: "column",
    marginTop: 4,
    maxWidth: "100%",
    width: 360,
  });
  switch (attachment.type) {
    case "table":
      return <SlackTable rows={attachment.rows} theme={theme} />;
    case "chart":
      return (
        <div style={{ ...card, padding: "8px 12px 10px" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{attachment.title}</div>
          <SlackChart color={slack.link} gridColor={slack.border} values={attachment.values} />
        </div>
      );
    case "tasks":
      return (
        <div style={{ ...card, padding: "6px 12px" }}>
          {attachment.title ? (
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{attachment.title}</div>
          ) : null}
          <div style={flex({ flexDirection: "column", gap: 4 })}>
            {attachment.tasks.map((task) => (
              <div key={task.title} style={flex({ gap: 8 })}>
                {/* Lucide's circle-check, filled in Slack green, as eve's task card draws it. */}
                <svg
                  fill={slack.green}
                  height={16}
                  stroke={slack.bg}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  style={{ flexShrink: 0, marginTop: 3 }}
                  viewBox="0 0 24 24"
                  width={16}
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                <Paragraph
                  runs={[
                    { style: { fontWeight: 700 }, text: task.title },
                    ...(task.output
                      ? [
                          {
                            style: { color: slack.muted, fontSize: 13, marginLeft: 8 },
                            text: task.output,
                          },
                        ]
                      : []),
                  ]}
                  style={{ minWidth: 0 }}
                  theme={theme}
                />
              </div>
            ))}
          </div>
        </div>
      );
    case "link":
      return (
        <div style={flex({ gap: 12, marginTop: 8 })}>
          <div
            style={{ backgroundColor: slack.unfurl, borderRadius: 9999, flexShrink: 0, width: 4 }}
          />
          <div style={flex({ flexDirection: "column", minWidth: 0 })}>
            <div style={flex({ alignItems: "center", color: slack.muted, fontSize: 12, gap: 6 })}>
              <IntegrationIcon integration={attachment.site} size={14} />
              {attachment.site}
            </div>
            <div style={{ color: slack.link, fontWeight: 700 }}>{attachment.title}</div>
            {attachment.description ? <div>{attachment.description}</div> : null}
          </div>
        </div>
      );
    case "approval":
      return (
        <div style={flex({ fontSize: 13, fontWeight: 700, gap: 8, marginTop: 6 })}>
          <div
            style={{
              backgroundColor: slack.button,
              border: "1px solid transparent",
              borderRadius: 4,
              color: "white",
              padding: "2px 10px",
            }}
          >
            {attachment.approve ?? "Approve"}
          </div>
          <div
            style={{ border: `1px solid ${slack.border}`, borderRadius: 4, padding: "2px 10px" }}
          >
            Cancel
          </div>
        </div>
      );
  }
};

/**
 * Slack's Markdown table: hairline grid, bold tinted header, numbers
 * right-aligned. Laid out in columns, so each one is as wide as its widest
 * cell, as an HTML table would be.
 */
const SlackTable = ({ rows, theme }: { rows: string[][]; theme: SceneTheme }) => {
  const { slack } = theme;
  const columns = rows[0]?.map((_, column) => rows.map((row) => row[column] ?? "")) ?? [];
  return (
    <div
      style={flex({ alignSelf: "flex-start", fontVariantNumeric: "tabular-nums", marginTop: 4 })}
    >
      {columns.map((cells, column) => (
        <div
          key={`${column}${cells[0]}`}
          style={flex({ flexDirection: "column", marginLeft: column ? -1 : 0 })}
        >
          {cells.map((cell, row) => (
            <div
              key={`${row}${cell}`}
              style={flex({
                backgroundColor: row === 0 ? slack.tint : undefined,
                border: `1px solid ${slack.border}`,
                fontWeight: row === 0 ? 700 : undefined,
                justifyContent: row > 0 && isNumericCell(cell) ? "flex-end" : "flex-start",
                marginTop: row ? -1 : 0,
                padding: "0 8px",
                whiteSpace: "nowrap",
              })}
            >
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

/** A native Slack line chart: one series with a soft fill and a dot on the latest value. */
const SlackChart = ({
  color,
  gridColor,
  values,
}: {
  color: string;
  gridColor: string;
  values: number[];
}) => {
  const { height, width } = SLACK_CHART;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => [
    (index / Math.max(values.length - 1, 1)) * width,
    height - 4 - ((value - min) / span) * (height - 8),
  ]);
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const [lastX, lastY] = points.at(-1) ?? [0, 0];
  return (
    <svg
      height={height}
      preserveAspectRatio="none"
      style={{ height, marginTop: 4, overflow: "visible", width: "100%" }}
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0.25, 0.75].map((ratio) => (
        <line
          key={ratio}
          stroke={gridColor}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={width}
          y1={height * ratio}
          y2={height * ratio}
        />
      ))}
      <polygon fill={color} fillOpacity={0.12} points={`0,${height} ${line} ${width},${height}`} />
      <polyline
        fill="none"
        points={line}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} fill={color} r={3} />
    </svg>
  );
};

// --- GitHub --------------------------------------------------------------

/**
 * An issue timeline, or a review thread when `preview.review` is set, under
 * GitHub's sticky header. Laid out at github.com's measured metrics (Mona
 * Sans 14/21, 40px timeline avatars, 6px boxes, 16px gutters) and Primer's
 * light and dark tokens, then zoomed down like the Slack preview. The card
 * is narrower than GitHub's desktop breakpoint, so gutters use GitHub's
 * 16px narrow-screen padding.
 */
const GitHub = ({ agent, assets, inset, preview, theme }: SurfaceProps & { inset: Inset }) => (
  <div style={windowStyle(theme, inset, theme.github.bg)}>
    <div
      style={flex({
        color: theme.github.fg,
        flexDirection: "column",
        fontFamily: theme.fonts.monaSans,
        fontSize: 14,
        left: 0,
        lineHeight: "21px",
        position: "absolute",
        right: 0,
        top: 0,
        zoom: GITHUB_ZOOM,
      })}
    >
      <GitHubHeader
        theme={theme}
        thread={preview.thread ?? { kind: "issue", number: 1, title: agent }}
      />
      {preview.review ? (
        <GitHubReview
          agent={agent}
          assets={assets}
          preview={preview}
          review={preview.review}
          theme={theme}
        />
      ) : (
        <GitHubTimeline agent={agent} assets={assets} preview={preview} theme={theme} />
      )}
    </div>
  </div>
);

/** The sticky header GitHub shows once you scroll: state, title, and number. */
const GitHubHeader = ({ theme, thread }: { theme: SceneTheme; thread: TemplatePreviewThread }) => {
  const { github } = theme;
  const draft = thread.kind === "pull" && thread.draft;
  const stateIcon =
    thread.kind === "issue"
      ? OCTICONS.issueOpened
      : draft
        ? OCTICONS.pullRequestDraft
        : OCTICONS.pullRequest;
  return (
    <div
      style={flex({
        alignItems: "center",
        borderBottom: `1px solid ${github.border}`,
        gap: 8,
        padding: "8px 16px",
      })}
    >
      <div
        style={flex({
          alignItems: "center",
          backgroundColor: draft ? github.draft : github.open,
          borderRadius: 9999,
          color: "white",
          flexShrink: 0,
          fontWeight: 600,
          height: 32,
          lineHeight: "16px",
          padding: "0 12px",
        })}
      >
        <Octicon paths={stateIcon} style={{ marginRight: 4 }} />
        {draft ? "Draft" : "Open"}
      </div>
      <div style={flex({ alignItems: "baseline", gap: 8, minWidth: 0 })}>
        <div
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {thread.title}
        </div>
        <div style={{ color: github.muted, flexShrink: 0 }}>{`#${thread.number}`}</div>
      </div>
    </div>
  );
};

/** GitHub draws apps and bots with rounded squares and people with circles, both ringed. */
const GitHubAvatar = ({
  assets,
  isAgent,
  size,
  style,
  theme,
}: {
  assets: SceneAssets;
  isAgent: boolean;
  size: number;
  style?: CSSProperties;
  theme: SceneTheme;
}) => {
  const ring = { boxShadow: `0 0 0 1px ${theme.github.avatarRing}`, ...style };
  return isAgent ? (
    <AgentIcon
      assets={assets}
      fallback={{ background: theme.colors.gray1000, color: theme.colors.background100 }}
      // The eve logo at the card's sizes: 12px on 40px timeline avatars, 8px on smaller ones.
      logoHeight={size >= 40 ? 12 : 8}
      size={size}
      style={{ borderRadius: 6, ...ring }}
    />
  ) : (
    <UserAvatar assets={assets} size={size} style={{ borderRadius: 9999, ...ring }} />
  );
};

/** Author, the `Bot` label for the agent, and the underlined relative time. */
const GitHubAuthor = ({
  agent,
  assets,
  isAgent,
  theme,
}: {
  agent: string;
  assets: SceneAssets;
  isAgent: boolean;
  theme: SceneTheme;
}) => {
  const { github } = theme;
  return (
    <div style={flex({ alignItems: "center", gap: 4 })}>
      <div style={{ color: github.fg, fontWeight: 600 }}>{isAgent ? agent : assets.userLogin}</div>
      {isAgent ? (
        <div
          style={{
            border: `1px solid ${github.border}`,
            borderRadius: 9999,
            color: github.muted,
            fontSize: 12,
            fontWeight: 500,
            lineHeight: "18px",
            padding: "0 6px",
          }}
        >
          Bot
        </div>
      ) : null}
      <div style={{ ...UNDERLINE, color: github.muted }}>now</div>
    </div>
  );
};

const UNDERLINE: CSSProperties = { textDecoration: "underline", textUnderlineOffset: 3.2 };

// The timeline's vertical line sits 16px into the comment column, which
// starts after the 40px avatar and a 16px gap.
const TIMELINE_COLUMN = 56;
const TIMELINE_LINE = 88;

const GitHubTimeline = ({ agent, assets, preview, theme }: SurfaceProps) => {
  const { github } = theme;
  return (
    <div style={flex({ flexDirection: "column", padding: "0 16px", position: "relative" })}>
      <div
        style={{
          backgroundColor: github.timeline,
          bottom: 0,
          left: TIMELINE_LINE,
          position: "absolute",
          top: 0,
          width: 2,
        }}
      />
      {preview.messages.map((message) =>
        message.event === "labeled" ? (
          <div
            key={message.text}
            style={flex({ padding: `16px 0 16px ${TIMELINE_COLUMN}px`, position: "relative" })}
          >
            {/* The badge centers on the line: 16px into the column, pulled back 15px. */}
            <div
              style={flex({
                alignItems: "center",
                backgroundColor: github.badgeBg,
                border: `2px solid ${github.bg}`,
                borderRadius: 9999,
                color: github.muted,
                flexShrink: 0,
                height: 32,
                justifyContent: "center",
                marginLeft: 1,
                marginRight: 8,
                width: 32,
              })}
            >
              <Octicon paths={OCTICONS.tag} />
            </div>
            <Paragraph
              runs={[
                <GitHubAvatar
                  assets={assets}
                  isAgent={false}
                  key="avatar"
                  size={20}
                  style={{ display: "inline-block", marginRight: 4, verticalAlign: "middle" }}
                  theme={theme}
                />,
                {
                  style: { color: github.fg, fontWeight: 600 },
                  text: assets.userLogin,
                  whole: true,
                },
                " added the ",
                {
                  style: {
                    backgroundColor: github.labelBg,
                    border: `1px solid ${github.labelBorder}`,
                    borderRadius: 9999,
                    color: github.labelFg,
                    display: "inline-block",
                    fontSize: 12,
                    fontWeight: 500,
                    lineHeight: "18px",
                    padding: "0 7px",
                  },
                  text: message.text,
                  whole: true,
                },
                " label now",
              ]}
              style={{ color: github.muted, marginTop: 5, minWidth: 0 }}
              theme={theme}
            />
          </div>
        ) : (
          <div
            key={message.text}
            style={flex({ padding: `16px 0 16px ${TIMELINE_COLUMN}px`, position: "relative" })}
          >
            <div style={flex({ left: 0, position: "absolute", top: 16 })}>
              <GitHubAvatar
                assets={assets}
                isAgent={message.from === "agent"}
                size={40}
                theme={theme}
              />
            </div>
            <div
              style={flex({
                backgroundColor: github.bg,
                border: `1px solid ${github.border}`,
                borderRadius: 6,
                flexDirection: "column",
                flexGrow: 1,
                position: "relative",
              })}
            >
              {/* GitHub's caret toward the avatar: a border-colored triangle under a header-colored one. */}
              <svg
                height={16}
                style={{ left: -8, position: "absolute", top: 11 }}
                viewBox="0 0 9 16"
                width={9}
              >
                <polygon fill={github.border} points="0,8 8,0 8,16" />
                <polygon fill={github.mutedBg} points="1,8 9,0 9,16" />
              </svg>
              <div
                style={flex({
                  alignItems: "center",
                  backgroundColor: github.mutedBg,
                  borderBottom: `1px solid ${github.border}`,
                  borderTopLeftRadius: 6,
                  borderTopRightRadius: 6,
                  color: github.muted,
                  gap: 4,
                  padding: "8px 16px",
                })}
              >
                <GitHubAuthor
                  agent={agent}
                  assets={assets}
                  isAgent={message.from === "agent"}
                  theme={theme}
                />
                <Octicon paths={OCTICONS.kebab} style={{ marginLeft: "auto" }} />
              </div>
              <GitHubText style={{ padding: 16 }} text={message.text} theme={theme} />
            </div>
          </div>
        ),
      )}
    </div>
  );
};

/**
 * A review thread on one added line, as it appears in the PR's conversation,
 * scrolled so the file path is under the sticky header and the agent's reply
 * is still on the card.
 */
const GitHubReview = ({
  agent,
  assets,
  preview,
  review,
  theme,
}: SurfaceProps & { review: { line: number; code: string } }) => {
  const { github } = theme;
  return (
    <div style={flex({ flexDirection: "column", padding: "0 16px" })}>
      <div
        style={flex({
          border: `1px solid ${github.border}`,
          borderBottomLeftRadius: 6,
          borderBottomRightRadius: 6,
          borderTopWidth: 0,
          flexDirection: "column",
          overflow: "hidden",
        })}
      >
        <div style={flex({ fontFamily: theme.fonts.mono, fontSize: 12, lineHeight: "20px" })}>
          <div style={{ backgroundColor: github.addNumberBg, flexShrink: 0, width: 50 }} />
          <div
            style={flex({
              backgroundColor: github.addNumberBg,
              flexShrink: 0,
              justifyContent: "flex-end",
              padding: "0 10px",
              width: 50,
            })}
          >
            {review.line}
          </div>
          <div
            style={flex({
              backgroundColor: github.addLineBg,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              padding: "0 10px 0 22px",
              position: "relative",
              whiteSpace: "pre",
            })}
          >
            <div style={{ left: 8, position: "absolute" }}>+</div>
            {parseDiffCode(review.code).map((token, index) => (
              <div
                key={`${index}${token.text}`}
                style={{
                  color:
                    token.kind === "number"
                      ? github.number
                      : token.kind === "keyword"
                        ? github.keyword
                        : undefined,
                }}
              >
                {token.text}
              </div>
            ))}
          </div>
        </div>
        {preview.messages.map((message) => (
          <div
            key={message.text}
            style={flex({
              borderTop: `1px solid ${github.border}`,
              flexDirection: "column",
              padding: "8px 16px",
            })}
          >
            <div
              style={flex({
                alignItems: "center",
                color: github.muted,
                gap: 4,
                marginLeft: -4,
                padding: "4px 0",
              })}
            >
              <GitHubAvatar
                assets={assets}
                isAgent={message.from === "agent"}
                size={24}
                style={{ marginRight: 8 }}
                theme={theme}
              />
              <GitHubAuthor
                agent={agent}
                assets={assets}
                isAgent={message.from === "agent"}
                theme={theme}
              />
              <Octicon paths={OCTICONS.kebab} style={{ marginLeft: "auto" }} />
            </div>
            <GitHubText style={{ marginLeft: 32 }} text={message.text} theme={theme} />
          </div>
        ))}
      </div>
    </div>
  );
};

/** Comment text in GitHub's Markdown styles, with link underlines on. */
const GitHubText = ({
  style,
  text,
  theme,
}: {
  style?: CSSProperties;
  text: string;
  theme: SceneTheme;
}) => {
  const { github } = theme;
  const styleOf = (segment: TextSegment): Run => {
    switch (segment.kind) {
      case "code":
        return {
          style: {
            backgroundColor: github.codeBg,
            borderRadius: 6,
            fontFamily: theme.fonts.mono,
            fontSize: "0.85em",
            padding: "0.2em 0.4em",
          },
          text: segment.text,
          whole: true,
        };
      case "mention":
        return {
          style: { ...UNDERLINE, color: github.fg, fontWeight: 600 },
          text: segment.text,
          whole: true,
        };
      case "link":
      case "reference":
        return { style: { ...UNDERLINE, color: github.link }, text: segment.text };
      default:
        return segment.text;
    }
  };
  return (
    <Paragraph runs={parseMessageText(text, "github").map(styleOf)} style={style} theme={theme} />
  );
};

// --- iMessage ------------------------------------------------------------

/** Liquid glass: translucent fill, a blurred backdrop, a bright top edge, and a soft drop shadow. */
const glass = (theme: SceneTheme): CSSProperties => {
  const { imessage } = theme;
  return {
    backdropFilter: "blur(12px) saturate(1.5)",
    backgroundColor: imessage.glassBg,
    boxShadow: `0 2px 6px ${imessage.glassDrop}, inset 0 0.5px 0 ${imessage.glassEdge}, inset 0 0 0 0.5px ${imessage.glassRing}`,
  };
};

const IMessage = ({ agent, assets, preview, theme }: SurfaceProps) => {
  const { colors, imessage } = theme;
  const { messages } = preview;
  return (
    <div
      style={{
        ...windowStyle(
          theme,
          { ...PHONE_FRAME, left: "50%", marginLeft: -PHONE_FRAME.width / 2 },
          colors.background100,
        ),
        borderRadius: 30,
        color: colors.gray1000,
        fontFamily: theme.fonts.sans,
        fontSize: 10.5,
        lineHeight: 1.3,
      }}
    >
      <div style={flex({ alignItems: "center", flexDirection: "column", paddingTop: 10 })}>
        <div
          style={flex({
            ...glass(theme),
            alignItems: "center",
            borderRadius: 9999,
            height: 24,
            justifyContent: "center",
            left: 12,
            position: "absolute",
            top: 14,
            width: 24,
          })}
        >
          <svg fill="none" height={10} viewBox="0 0 7 12" width={10 * (7 / 12)}>
            <path
              d="M6 1 1 6l5 5"
              stroke={colors.gray1000}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        </div>
        <AgentIcon
          assets={assets}
          fallback={{
            background: `linear-gradient(to bottom, ${imessage.avatarTop}, ${imessage.avatarBottom})`,
            color: "white",
          }}
          logoHeight={8}
          size={32}
          style={{
            borderRadius: 9999,
            boxShadow: `0 0 0 0.5px ${imessage.avatarRing}, 0 1px 4px rgba(0,0,0,0.18)`,
            position: "relative",
            zIndex: 10,
          }}
        />
        <div
          style={flex({
            ...glass(theme),
            borderRadius: 9999,
            fontSize: 9.5,
            fontWeight: 600,
            marginTop: -4,
            padding: "2px 8px",
          })}
        >
          {agent}
          <div style={{ color: imessage.muted, fontWeight: 400, marginLeft: 2 }}>›</div>
        </div>
      </div>
      <div style={flex({ flexDirection: "column", padding: "8px 14px 0" })}>
        {messages.map((message, index) => {
          const sent = message.from === "user";
          const next = messages[index + 1];
          const tail = !next || next.from !== message.from;
          const bubble = sent ? imessage.sent : imessage.received;
          return (
            <div
              key={message.text}
              style={flex({
                alignSelf: sent ? "flex-end" : "flex-start",
                backgroundColor: bubble,
                borderRadius: 14,
                color: sent ? "white" : undefined,
                marginBottom: tail && next ? 6 : 2,
                maxWidth: "78%",
                padding: "5px 10px",
                position: "relative",
              })}
            >
              {tail ? (
                <BubbleTail background={colors.background100} bubble={bubble} sent={sent} />
              ) : null}
              {message.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * The bubble's tail: a bubble-colored corner, with a screen-colored cutout
 * that carves its curve.
 */
const BubbleTail = ({
  background,
  bubble,
  sent,
}: {
  background: string;
  bubble: string;
  sent: boolean;
}) => {
  // Positioned from the left on both sides, since next/og ignores `right` on a shrink-wrapped parent.
  const corner = sent ? "borderBottomLeftRadius" : "borderBottomRightRadius";
  return (
    <>
      <div
        style={{
          backgroundColor: bubble,
          bottom: 0,
          [corner]: "11px 10px",
          height: 14,
          left: sent ? "100%" : -5,
          marginLeft: sent ? -9 : 0,
          position: "absolute",
          width: 14,
        }}
      />
      <div
        style={{
          backgroundColor: background,
          bottom: 0,
          [corner]: 7,
          height: 14,
          left: sent ? "100%" : -18,
          position: "absolute",
          width: 18,
        }}
      />
    </>
  );
};

// --- Placeholder ---------------------------------------------------------

/** For templates without a preview: the eve logo plus up to four integration icons. */
const Placeholder = ({
  integrations,
  theme,
}: {
  integrations: TemplateIntegration[];
  theme: SceneTheme;
}) => {
  const { colors } = theme;
  const tile: CSSProperties = flex({
    alignItems: "center",
    backgroundColor: colors.background100,
    border: `1px solid ${colors.grayAlpha400}`,
    borderRadius: 10,
    color: colors.gray1000,
    flexShrink: 0,
    height: 44,
    justifyContent: "center",
    minWidth: 44,
    padding: "0 10px",
  });
  return (
    <div
      style={flex({
        alignItems: "center",
        bottom: 0,
        fontSize: 16,
        gap: 10,
        justifyContent: "center",
        left: 0,
        padding: "0 16px",
        position: "absolute",
        right: 0,
        top: 0,
      })}
    >
      <div style={tile}>
        <EveLogo height={14} />
      </div>
      <div style={{ color: colors.gray700 }}>+</div>
      {integrations.slice(0, MAX_PLACEHOLDER_ICONS).map((integration) => (
        <div key={integration} style={tile}>
          <div style={flex({ filter: "grayscale(1)" })}>
            <IntegrationIcon grayscale integration={integration} size={20} />
          </div>
        </div>
      ))}
    </div>
  );
};
