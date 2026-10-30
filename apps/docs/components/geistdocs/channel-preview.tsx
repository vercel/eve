// The decorative header above a channel docs page: a sample conversation in
// the style of that channel. Adapted from the template card previews drafted
// in vercel/eve#5133, keeping their measured app metrics and palettes. Slack
// and GitHub are laid out at their real desktop sizes, then zoomed down.
import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import { Lato, Mona_Sans } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import {
  GITHUB_COLORS,
  githubAvatarUrl,
  IMESSAGE_COLORS,
  isNumericCell,
  OCTICONS,
  type PreviewUser,
  paletteVarRefs,
  paletteVars,
  parseMessageText,
  pickPreviewUser,
  SLACK_COLORS,
  type TextSegment,
} from "@/lib/channel-previews/kit";
import type { ChannelPreview, ChannelScene, PreviewMessage } from "@/lib/channel-previews/scenes";

// Not preloaded: every docs page imports this module, but only channel pages use the fonts.
const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  display: "swap",
  preload: false,
  fallback: ["Helvetica Neue", "Helvetica", "Segoe UI", "Arial", "sans-serif"],
});

const monaSans = Mona_Sans({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Noto Sans", "Helvetica", "Arial"],
});

const slack = paletteVarRefs("slack", SLACK_COLORS);
const github = paletteVarRefs("gh", GITHUB_COLORS);
const imessage = paletteVarRefs("im", IMESSAGE_COLORS);
const PALETTE_VARS = {
  ...paletteVars("slack", SLACK_COLORS),
  ...paletteVars("gh", GITHUB_COLORS),
  ...paletteVars("im", IMESSAGE_COLORS),
} as CSSProperties;

const SLACK_ZOOM = 0.72;
const GITHUB_ZOOM = 0.7;
const SLACK_CODE_FONT = "Monaco, Menlo, Consolas, var(--font-mono), monospace";
const GITHUB_CODE_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Where Slack and GitHub windows sit in the header; they run off the bottom edge. */
const APP_WINDOW: CSSProperties = { top: 16, bottom: -20, left: 20, right: 20 };
/** The iMessage phone: centered, and taller than the header so it runs off the bottom. */
const PHONE_FRAME = { top: 16, bottom: -40, width: 256 };

/**
 * Rendered above the page title. It repeats nothing from the page and agents
 * never see it, so screen readers get a one-sentence description instead.
 */
export const ChannelPreviewHeader = ({ preview }: { preview: ChannelPreview }) => {
  const { scene } = preview;
  const user = pickPreviewUser(scene.agent + scene.surface);
  return (
    <div
      aria-label={preview.alt}
      // `light-dark()` in the palette variables follows the color scheme, so pin it to the site theme.
      className="not-prose relative mb-8 h-52 overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-200 [color-scheme:light] dark:[color-scheme:dark]"
      role="img"
      style={PALETTE_VARS}
    >
      {/* Fade toward the title so the conversation reads as a hint, not competing text. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ maskImage: "linear-gradient(to bottom, #000 85%, transparent)" }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: "radial-gradient(var(--ds-gray-alpha-500) 1px, transparent 1px)",
            backgroundSize: "8px 8px",
            maskImage: "radial-gradient(ellipse at 50% 0%, #000 20%, transparent 75%)",
          }}
        />
        <div className="absolute inset-y-0 left-1/2 w-full max-w-[520px] -translate-x-1/2">
          <Scene scene={scene} user={user} />
        </div>
      </div>
    </div>
  );
};

const Scene = ({ scene, user }: { scene: ChannelScene; user: PreviewUser }) => {
  switch (scene.surface) {
    case "slack":
      return (
        <Slack agent={scene.agent} channel={scene.channel} messages={scene.messages} user={user} />
      );
    case "github":
      return <GitHub scene={scene} user={user} />;
    case "imessage":
      return <IMessage agent={scene.agent} messages={scene.messages} />;
  }
};

// --- Shared pieces -------------------------------------------------------

const flex = (style: CSSProperties = {}): CSSProperties => ({ display: "flex", ...style });

/** A window: hairline Geist border, rounded corners, clipped content. */
const windowStyle = (position: CSSProperties, background: string): CSSProperties => ({
  ...position,
  backgroundColor: background,
  border: "1px solid var(--ds-gray-alpha-400)",
  borderRadius: 8,
  boxShadow: "0 2px 2px rgba(0,0,0,0.04)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "absolute",
});

type Run = string | { text: string; style: CSSProperties };

const Paragraph = ({ runs, style }: { runs: Run[]; style?: CSSProperties }) => (
  <p style={{ overflowWrap: "break-word", ...style }}>
    {runs.map((run, index) =>
      typeof run === "string" ? (
        run
      ) : (
        <span key={`${index}${run.text}`} style={run.style}>
          {run.text}
        </span>
      ),
    )}
  </p>
);

const Octicon = ({ paths, style }: { paths: string[]; style?: CSSProperties }) => (
  <svg
    fill="currentColor"
    height={16}
    style={{ flexShrink: 0, ...style }}
    viewBox="0 0 16 16"
    width={16}
  >
    {paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);

/** The eve logo on `background`, as the agent's avatar. */
const AgentIcon = ({
  background,
  color,
  logoHeight,
  size,
  style,
}: {
  background: string;
  color: string;
  logoHeight: number;
  size: number;
  style?: CSSProperties;
}) => (
  <div
    style={flex({
      alignItems: "center",
      background,
      color,
      flexShrink: 0,
      height: size,
      justifyContent: "center",
      width: size,
      ...style,
    })}
  >
    <LogoEveSvg height={logoHeight} />
  </div>
);

const UserAvatar = ({
  size,
  style,
  user,
}: {
  size: number;
  style?: CSSProperties;
  user: PreviewUser;
}) => (
  // oxlint-disable-next-line nextjs/no-img-element -- tiny decorative avatar
  <img
    alt=""
    height={size}
    loading="lazy"
    src={githubAvatarUrl(user)}
    style={{ flexShrink: 0, height: size, objectFit: "cover", width: size, ...style }}
    width={size}
  />
);

// --- Slack ---------------------------------------------------------------

/** Slack's desktop metrics: Lato 15/22, 36px avatars, 8px 20px message gutters, 49px channel header. */
const Slack = ({
  agent,
  channel,
  messages,
  user,
}: {
  agent: string;
  channel: string;
  messages: PreviewMessage[];
  user: PreviewUser;
}) => (
  <div style={windowStyle(APP_WINDOW, slack.bg)}>
    <div
      style={flex({
        color: slack.fg,
        flexDirection: "column",
        fontFamily: lato.style.fontFamily,
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
        <div>{channel}</div>
      </div>
      <div style={flex({ flexDirection: "column", paddingTop: 8 })}>
        {messages.map((message, index) => {
          const isAgent = message.from === "agent";
          const body = (
            <>
              <SlackText text={message.text} />
              {message.table ? <SlackTable rows={message.table} /> : null}
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
                  background="var(--ds-gray-1000)"
                  color="var(--ds-background-100)"
                  logoHeight={11}
                  size={36}
                  style={{ borderRadius: 8 }}
                />
              ) : (
                <UserAvatar
                  size={36}
                  style={{ backgroundColor: slack.hairline, borderRadius: 8 }}
                  user={user}
                />
              )}
              <div style={flex({ flex: 1, flexDirection: "column", minWidth: 0 })}>
                <div style={flex({ alignItems: "baseline", gap: 4 })}>
                  <div style={{ color: slack.strong, fontWeight: 900 }}>
                    {isAgent ? agent : user.name}
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
                  <div style={{ color: slack.muted, fontSize: 12, marginLeft: 4 }}>10:42 AM</div>
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

/** Message text with Slack's inline code, link, and user mention styles. */
const SlackText = ({ text }: { text: string }) => {
  const styleOf = (segment: TextSegment): Run => {
    switch (segment.kind) {
      case "code":
        return {
          style: {
            backgroundColor: slack.codeBg,
            border: `1px solid ${slack.hairline}`,
            borderRadius: 3,
            color: slack.codeFg,
            fontFamily: SLACK_CODE_FONT,
            fontSize: 12,
            padding: "2px 3px 1px",
          },
          text: segment.text,
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
        };
      default:
        return segment.text;
    }
  };
  return <Paragraph runs={parseMessageText(text, "slack").map(styleOf)} />;
};

/** Slack's Markdown table: hairline grid, bold tinted header, numbers right-aligned. */
const SlackTable = ({ rows }: { rows: string[][] }) => (
  <table
    style={{
      alignSelf: "flex-start",
      borderCollapse: "collapse",
      fontVariantNumeric: "tabular-nums",
      marginTop: 4,
    }}
  >
    <tbody>
      {rows.map((row, rowIndex) => (
        <tr key={row.join()}>
          {row.map((cell, column) => (
            <td
              key={`${column}${cell}`}
              style={{
                backgroundColor: rowIndex === 0 ? slack.tint : undefined,
                border: `1px solid ${slack.border}`,
                fontWeight: rowIndex === 0 ? 700 : undefined,
                padding: "0 8px",
                textAlign: rowIndex > 0 && isNumericCell(cell) ? "right" : "left",
                whiteSpace: "nowrap",
              }}
            >
              {cell}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

// --- GitHub --------------------------------------------------------------

type GitHubScene = Extract<ChannelScene, { surface: "github" }>;

const UNDERLINE: CSSProperties = { textDecoration: "underline", textUnderlineOffset: 3.2 };

// The timeline's vertical line sits 16px into the comment column, which
// starts after the 40px avatar and a 16px gap.
const TIMELINE_COLUMN = 56;
const TIMELINE_LINE = 88;
/** Hides the first comment's top padding, header, and avatar ring. */
const TIMELINE_SCROLL = 58;

/**
 * An issue timeline under GitHub's sticky header, at github.com's metrics
 * (Mona Sans 14/21, 40px avatars, 6px boxes) and its narrow-screen 16px gutters.
 */
const GitHub = ({ scene, user }: { scene: GitHubScene; user: PreviewUser }) => (
  <div style={windowStyle(APP_WINDOW, github.bg)}>
    <div
      style={flex({
        color: github.fg,
        flexDirection: "column",
        fontFamily: monaSans.style.fontFamily,
        fontSize: 14,
        left: 0,
        lineHeight: "21px",
        position: "absolute",
        right: 0,
        top: 0,
        zoom: GITHUB_ZOOM,
      })}
    >
      <div
        style={flex({
          alignItems: "center",
          backgroundColor: github.bg,
          borderBottom: `1px solid ${github.border}`,
          gap: 8,
          padding: "8px 16px",
          position: "relative",
          zIndex: 1,
        })}
      >
        <div
          style={flex({
            alignItems: "center",
            backgroundColor: github.open,
            borderRadius: 9999,
            color: "white",
            flexShrink: 0,
            fontWeight: 600,
            height: 32,
            lineHeight: "16px",
            padding: "0 12px",
          })}
        >
          <Octicon
            paths={scene.thread.kind === "issue" ? OCTICONS.issueOpened : OCTICONS.pullRequest}
            style={{ marginRight: 4 }}
          />
          Open
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
            {scene.thread.title}
          </div>
          <div style={{ color: github.muted, flexShrink: 0 }}>{`#${scene.thread.number}`}</div>
        </div>
      </div>
      {/* Scrolled under the sticky header, so the first comment's header is out of view. */}
      <div
        style={flex({
          flexDirection: "column",
          marginTop: -TIMELINE_SCROLL,
          padding: "0 16px",
          position: "relative",
        })}
      >
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
        {scene.messages.map((message) => {
          const isAgent = message.from === "agent";
          const ring = `0 0 0 1px ${github.avatarRing}`;
          return (
            <div
              key={message.text}
              style={flex({ padding: `16px 0 16px ${TIMELINE_COLUMN}px`, position: "relative" })}
            >
              <div style={flex({ left: 0, position: "absolute", top: 16 })}>
                {/* GitHub draws apps with rounded squares and people with circles. */}
                {isAgent ? (
                  <AgentIcon
                    background="var(--ds-gray-1000)"
                    color="var(--ds-background-100)"
                    logoHeight={12}
                    size={40}
                    style={{ borderRadius: 6, boxShadow: ring }}
                  />
                ) : (
                  <UserAvatar
                    size={40}
                    style={{ borderRadius: 9999, boxShadow: ring }}
                    user={user}
                  />
                )}
              </div>
              <div
                style={flex({
                  backgroundColor: github.bg,
                  border: `1px solid ${github.border}`,
                  borderRadius: 6,
                  flexDirection: "column",
                  flexGrow: 1,
                  minWidth: 0,
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
                  <div style={{ color: github.fg, fontWeight: 600 }}>
                    {isAgent ? scene.agent : user.login}
                  </div>
                  {isAgent ? (
                    <div
                      style={{
                        border: `1px solid ${github.border}`,
                        borderRadius: 9999,
                        fontSize: 12,
                        fontWeight: 500,
                        lineHeight: "18px",
                        padding: "0 6px",
                      }}
                    >
                      Bot
                    </div>
                  ) : null}
                  <div style={UNDERLINE}>now</div>
                  <Octicon paths={OCTICONS.kebab} style={{ marginLeft: "auto" }} />
                </div>
                <GitHubText text={message.text} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

/** Comment text in GitHub's Markdown styles, with link underlines on. */
const GitHubText = ({ text }: { text: string }) => {
  const styleOf = (segment: TextSegment): Run => {
    switch (segment.kind) {
      case "code":
        return {
          style: {
            backgroundColor: github.codeBg,
            borderRadius: 6,
            fontFamily: GITHUB_CODE_FONT,
            fontSize: "0.85em",
            padding: "0.2em 0.4em",
          },
          text: segment.text,
        };
      case "mention":
        return { style: { ...UNDERLINE, color: github.fg, fontWeight: 600 }, text: segment.text };
      case "link":
      case "reference":
        return { style: { ...UNDERLINE, color: github.link }, text: segment.text };
      default:
        return segment.text;
    }
  };
  return <Paragraph runs={parseMessageText(text, "github").map(styleOf)} style={{ padding: 16 }} />;
};

// --- iMessage ------------------------------------------------------------

/** Liquid glass: translucent fill, a blurred backdrop, a bright top edge, and a soft drop shadow. */
const GLASS: CSSProperties = {
  backdropFilter: "blur(12px) saturate(1.5)",
  backgroundColor: imessage.glassBg,
  boxShadow: `0 2px 6px ${imessage.glassDrop}, inset 0 0.5px 0 ${imessage.glassEdge}, inset 0 0 0 0.5px ${imessage.glassRing}`,
};

const IMessage = ({ agent, messages }: { agent: string; messages: PreviewMessage[] }) => (
  <div
    style={{
      ...windowStyle(
        { ...PHONE_FRAME, left: "50%", marginLeft: -PHONE_FRAME.width / 2 },
        "var(--ds-background-100)",
      ),
      borderRadius: 30,
      color: "var(--ds-gray-1000)",
      fontSize: 10.5,
      lineHeight: 1.3,
    }}
  >
    <div style={flex({ alignItems: "center", flexDirection: "column", paddingTop: 10 })}>
      <div
        style={flex({
          ...GLASS,
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
            stroke="var(--ds-gray-1000)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </div>
      <AgentIcon
        background={`linear-gradient(to bottom, ${imessage.avatarTop}, ${imessage.avatarBottom})`}
        color="white"
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
          ...GLASS,
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
            {tail ? <BubbleTail bubble={bubble} sent={sent} /> : null}
            {message.text}
          </div>
        );
      })}
    </div>
  </div>
);

/** The bubble's tail: a bubble-colored corner, with a screen-colored cutout that carves its curve. */
const BubbleTail = ({ bubble, sent }: { bubble: string; sent: boolean }): ReactNode => {
  const corner = sent ? "borderBottomLeftRadius" : "borderBottomRightRadius";
  const side = sent ? "right" : "left";
  return (
    <>
      <div
        style={{
          backgroundColor: bubble,
          bottom: 0,
          [corner]: "11px 10px",
          height: 14,
          [side]: -5,
          position: "absolute",
          width: 14,
        }}
      />
      <div
        style={{
          backgroundColor: "var(--ds-background-100)",
          bottom: 0,
          [corner]: 7,
          height: 14,
          [side]: -18,
          position: "absolute",
          width: 18,
        }}
      />
    </>
  );
};
