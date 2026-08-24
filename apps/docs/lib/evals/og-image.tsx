import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { BenchmarkRow } from "./results";

const evalsOgImageSize = {
  width: 1200,
  height: 628,
};

const fontDirectory = join(process.cwd(), "app/[lang]/og/[...slug]");
const fonts = Promise.all([
  readFile(join(fontDirectory, "geist-sans-regular.ttf")),
  readFile(join(fontDirectory, "geist-sans-semibold.ttf")),
]);

const Rate = ({ value }: { value: number | null }) => {
  if (value === null) return <div style={{ display: "flex" }}>—</div>;

  return (
    <div style={{ display: "flex" }}>
      {[...String(Math.round(value))].map((digit, index) => (
        <div key={index} style={{ display: "flex", justifyContent: "center", width: 14 }}>
          {digit}
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "center", width: 18 }}>%</div>
    </div>
  );
};

const latestResults = (rows: BenchmarkRow[]): BenchmarkRow[] =>
  [...rows].sort(
    (left, right) =>
      (right.guidedSuccessRate ?? -1) - (left.guidedSuccessRate ?? -1) ||
      (right.baselineSuccessRate ?? -1) - (left.baselineSuccessRate ?? -1) ||
      left.modelDisplayName.localeCompare(right.modelDisplayName),
  );

export const createEvalsOgImage = async (rows: BenchmarkRow[]): Promise<ImageResponse> => {
  const [regularFont, semiboldFont] = await fonts;
  const results = latestResults(rows);

  return new ImageResponse(
    <div
      style={{
        background: "black",
        color: "white",
        display: "flex",
        fontFamily: "Geist",
        height: "100%",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          color: "white",
          display: "flex",
          left: 60,
          position: "absolute",
          top: 60,
        }}
      >
        <LogoEve height={30} />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          fontSize: 76,
          fontWeight: 400,
          left: 60,
          letterSpacing: "-0.06em",
          lineHeight: 0.95,
          position: "absolute",
          top: 241,
        }}
      >
        <div style={{ display: "flex" }}>Agent</div>
        <div style={{ display: "flex" }}>Benchmarks</div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          left: 600,
          position: "absolute",
          top: 163,
          width: 540,
        }}
      >
        <div
          style={{
            borderBottom: "1px solid #333333",
            color: "#777777",
            display: "flex",
            fontSize: 18,
            fontWeight: 500,
            paddingBottom: 12,
            width: "100%",
          }}
        >
          <div style={{ display: "flex", flex: 1 }}>Model</div>
          <div style={{ display: "flex", justifyContent: "flex-end", width: 84 }}>Base</div>
          <div style={{ display: "flex", justifyContent: "flex-end", width: 104 }}>Guided</div>
        </div>
        {results.map((row, index) => (
          <div
            key={row.groupId}
            style={{
              alignItems: "center",
              borderBottom: "1px solid #222222",
              display: "flex",
              fontSize: 24,
              height: 52,
              letterSpacing: "-0.025em",
              opacity: index < 5 ? 1 : 2 ** (4 - index),
              width: "100%",
            }}
          >
            <div
              style={{
                display: "flex",
                flex: 1,
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {row.modelDisplayName}
            </div>
            <div
              style={{
                color: "#888888",
                display: "flex",
                fontSize: 24,
                justifyContent: "flex-end",
                letterSpacing: 0,
                width: 84,
              }}
            >
              <Rate value={row.baselineSuccessRate} />
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 24,
                fontWeight: 500,
                justifyContent: "flex-end",
                letterSpacing: 0,
                width: 104,
              }}
            >
              <Rate value={row.guidedSuccessRate} />
            </div>
          </div>
        ))}
      </div>
    </div>,
    {
      ...evalsOgImageSize,
      fonts: [
        {
          name: "Geist",
          data: regularFont,
          weight: 400,
        },
        {
          name: "Geist",
          data: semiboldFont,
          weight: 500,
        },
      ],
    },
  );
};
