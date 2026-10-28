import { Lato, Mona_Sans } from "next/font/google";
import type {
  TemplateIntegration,
  TemplatePreview as TemplatePreviewData,
} from "@/lib/templates/manifest";
import {
  dotMatrixVariant,
  GITHUB_COLORS,
  githubAvatarUrl,
  IMESSAGE_COLORS,
  PREVIEW_FADE_FROM,
  paletteVarRefs,
  paletteVars,
  pickPreviewUser,
  SLACK_COLORS,
} from "@/lib/templates/preview-kit";
import { PreviewScene, type SceneAssets, type SceneTheme } from "@/lib/templates/preview-scene";

/** Slack's UI typeface. Loaded only for the Slack preview. */
const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  display: "swap",
  fallback: ["Helvetica Neue", "Helvetica", "Segoe UI", "Arial", "sans-serif"],
});

/** GitHub's UI typeface. Loaded only for the GitHub preview. */
const monaSans = Mona_Sans({
  subsets: ["latin"],
  display: "swap",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Noto Sans", "Helvetica", "Arial"],
});

/**
 * Geist tokens and the app palettes as CSS variables, so the one inline-styled
 * scene follows the site's light and dark themes.
 */
const domTheme: SceneTheme = {
  target: "dom",
  colors: {
    background100: "var(--ds-background-100)",
    background100Clear: "transparent",
    gray700: "var(--ds-gray-700)",
    gray800: "var(--ds-gray-800)",
    gray900: "var(--ds-gray-900)",
    gray1000: "var(--ds-gray-1000)",
    grayAlpha400: "var(--ds-gray-alpha-400)",
    red800: "var(--ds-red-800)",
    shadowSmall: "0 2px 2px rgba(0,0,0,0.04)",
  },
  slack: paletteVarRefs("slack", SLACK_COLORS),
  github: paletteVarRefs("gh", GITHUB_COLORS),
  imessage: paletteVarRefs("im", IMESSAGE_COLORS),
  fonts: {
    sans: "inherit",
    lato: lato.style.fontFamily,
    monaSans: monaSans.style.fontFamily,
    slackCode: "Monaco, Menlo, Consolas, var(--font-mono), monospace",
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
};

const PALETTE_VARS = {
  ...paletteVars("slack", SLACK_COLORS),
  ...paletteVars("gh", GITHUB_COLORS),
  ...paletteVars("im", IMESSAGE_COLORS),
};

interface TemplatePreviewProps {
  integrations: TemplateIntegration[];
  preview?: TemplatePreviewData;
  title: string;
}

/** Decorative card header: a sample conversation, or a placeholder built from integrations. */
export const TemplatePreview = ({ integrations, preview, title }: TemplatePreviewProps) => {
  const user = pickPreviewUser(preview?.agent ?? title);
  const assets: SceneAssets = {
    agentIcon: preview?.icon,
    userAvatar: githubAvatarUrl(user),
    userLogin: user.login,
    userName: user.name,
  };
  const scene = (
    <PreviewScene assets={assets} template={{ integrations, preview, title }} theme={domTheme} />
  );
  return (
    <div
      aria-hidden="true"
      // `light-dark()` in the palette variables follows the color scheme, so pin it to the site theme.
      className="relative -mx-4 -mt-4 mb-4 h-48 overflow-hidden rounded-t-lg border-b border-gray-alpha-400 bg-background-200 scheme-light dark:scheme-dark"
      style={PALETTE_VARS}
    >
      {preview ? (
        // Fade the conversation out toward the title so it reads as a hint, not competing text.
        // The dots fade with it, so they never show through the translucent part of the window.
        <div
          className="absolute inset-0"
          style={{
            maskImage: `linear-gradient(to bottom, #000 ${PREVIEW_FADE_FROM * 100}%, transparent)`,
          }}
        >
          <DotMatrix seed={title} />
          {scene}
        </div>
      ) : (
        <>
          <DotMatrix seed={title} />
          {scene}
        </>
      )}
    </div>
  );
};

/**
 * Dot-matrix backdrop after the vercel.com/agent OG image. The SVG masks
 * gray-1000, so light and dark mode come from tokens.
 */
const DotMatrix = ({ seed }: { seed: string }) => (
  <div
    className="absolute inset-0 bg-gray-1000 [mask-position:0_0] [mask-repeat:no-repeat]"
    style={{ maskImage: `url(/templates/dot-matrix/${dotMatrixVariant(seed)}.svg)` }}
  />
);
