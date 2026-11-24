import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { resolveLogo } from "@/lib/og-logo";
import { challengeDeadline, challengeHeadline, challengeTitle } from "./challenge-details";
import { glyphFieldSvg } from "./glyphs";
import { loopHeight, loopWidth, stillLoop } from "./harness-loop";

export const alt = challengeTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const inset = 72;
const titleWidth = 420;
const artworkWidth = size.width - 2 * inset - titleWidth - 40;
const artworkHeight = Math.round((artworkWidth * loopHeight) / loopWidth);
const fontDirectory = join(process.cwd(), "app/[lang]/og/[...slug]");
const fonts = Promise.all([
  readFile(join(fontDirectory, "geist-sans-regular.ttf")),
  readFile(join(fontDirectory, "geist-sans-semibold.ttf")),
]);
const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const backdrop = dataUri(
  glyphFieldSvg(
    {
      columns: 75,
      rows: 40,
      seed: 7,
      density: 0.16,
      brightness: 0.1,
      clearing: { x: 0.2, y: 0.5, radiusX: 0.32, radiusY: 0.6 },
    },
    "#3d3d3d",
  ),
);
const loop = dataUri(stillLoop.svg);

export default async function ChallengeOpenGraphImage() {
  const [regularFont, semiboldFont] = await fonts;
  return new ImageResponse(
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        fontFamily: "Geist",
        background: "#000",
        color: "#fff",
      }}
    >
      <img
        alt=""
        height={640}
        src={backdrop}
        style={{ position: "absolute", top: 0, left: 0, opacity: 0.66 }}
        width={1200}
      />
      <div style={{ position: "absolute", display: "flex", top: inset, left: inset }}>
        {resolveLogo(<LogoEveSvg height={36} />)}
      </div>
      <div
        style={{
          position: "absolute",
          top: 276,
          left: inset,
          display: "flex",
          flexDirection: "column",
          width: titleWidth,
        }}
      >
        <div
          style={{
            display: "flex",
            fontWeight: 600,
            fontSize: 82,
            letterSpacing: -4,
            lineHeight: 0.94,
          }}
        >
          {challengeHeadline}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            fontSize: 22,
            color: "#a1a1a1",
          }}
        >
          {`Open until ${challengeDeadline}`}
        </div>
      </div>
      <img
        alt=""
        height={artworkHeight}
        src={loop}
        style={{ position: "absolute", right: inset, top: (size.height - artworkHeight) / 2 }}
        width={artworkWidth}
      />
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: regularFont, weight: 400 },
        { name: "Geist", data: semiboldFont, weight: 600 },
      ],
    },
  );
}
