import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { challengeDeadline, challengeHeadline, challengeTitle } from "./challenge-details";
import { glyphFieldSvg } from "./glyphs";
import { stillLoop } from "./harness-loop";

export const alt = challengeTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonts = Promise.all([
  readFile(join(process.cwd(), "app/[lang]/og/[...slug]/geist-sans-semibold.ttf")),
  readFile(join(process.cwd(), "node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf")),
]);
const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const backdrop = dataUri(
  glyphFieldSvg(
    {
      columns: 75,
      rows: 40,
      seed: 7,
      density: 0.2,
      brightness: 0.1,
      clearing: { x: 0.2, y: 0.5, radiusX: 0.32, radiusY: 0.6 },
    },
    "#3d3d3d",
  ),
);
const loop = dataUri(stillLoop.svg);

export default async function ChallengeOpenGraphImage() {
  const [sans, mono] = await fonts;
  return new ImageResponse(
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 48,
        padding: "0 60px",
        background: "#000",
        color: "#fff",
      }}
    >
      <img
        alt=""
        height={640}
        src={backdrop}
        style={{ position: "absolute", top: 0, left: 0 }}
        width={1200}
      />
      <div style={{ display: "flex", flexDirection: "column", width: 480 }}>
        <div style={{ display: "flex", fontFamily: "Geist Mono", fontSize: 22, color: "#a1a1a1" }}>
          {`Open until ${challengeDeadline}`}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            fontFamily: "Geist",
            fontSize: 82,
            letterSpacing: -4,
            lineHeight: 0.94,
          }}
        >
          {challengeHeadline}
        </div>
      </div>
      <img alt="" height={480} src={loop} width={614} />
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: sans, weight: 600 },
        { name: "Geist Mono", data: mono, weight: 400 },
      ],
    },
  );
}
