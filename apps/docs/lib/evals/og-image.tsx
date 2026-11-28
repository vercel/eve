import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { resolveLogo } from "../og-logo";
import {
  formatDurationMs,
  formatPercent,
  isReferenceHarness,
  modelFamilyLabel,
  modelShortName,
  rankedHarnesses,
} from "./eve-format";
import type { EveModelResults } from "./eve-results";
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

const formatRate = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate)}%`);

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
        {resolveLogo(<LogoEveSvg height={30} />)}
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
        {results.map((row) => (
          <div
            key={row.groupId}
            style={{
              alignItems: "center",
              borderBottom: "1px solid #222222",
              display: "flex",
              fontSize: 24,
              height: 52,
              letterSpacing: "-0.025em",
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
                justifyContent: "flex-end",
                width: 84,
              }}
            >
              {formatRate(row.baselineSuccessRate)}
            </div>
            <div
              style={{
                display: "flex",
                fontWeight: 500,
                justifyContent: "flex-end",
                width: 104,
              }}
            >
              {formatRate(row.guidedSuccessRate)}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "linear-gradient(to bottom, transparent 0%, black 100%)",
          bottom: 0,
          display: "flex",
          height: 230,
          position: "absolute",
          right: 0,
          width: 600,
        }}
      />
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

export const createBenchmarksOgImage = async (
  models: EveModelResults[],
): Promise<ImageResponse> => {
  const [regularFont, semiboldFont] = await fonts;

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
        {resolveLogo(<LogoEveSvg height={30} />)}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          left: 60,
          position: "absolute",
          top: 220,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 76,
            fontWeight: 400,
            letterSpacing: "-0.06em",
            lineHeight: 0.95,
          }}
        >
          <div style={{ display: "flex" }}>eve</div>
          <div style={{ display: "flex" }}>Benchmarks</div>
        </div>
        <div
          style={{
            color: "#888888",
            display: "flex",
            fontSize: 22,
            marginTop: 22,
          }}
        >
          DeepSWE-lean · OpenAI & Anthropic
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 28,
          left: 580,
          position: "absolute",
          top: 108,
          width: 560,
        }}
      >
        {models.slice(0, 2).map((modelEntry) => {
          const ranked = rankedHarnesses(modelEntry);
          return (
            <div
              key={modelEntry.family}
              style={{
                border: "1px solid #2a2a2a",
                borderRadius: 16,
                display: "flex",
                flexDirection: "column",
                padding: "18px 22px",
                width: "100%",
              }}
            >
              <div
                style={{
                  color: "#888888",
                  display: "flex",
                  fontSize: 16,
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex" }}>
                  {modelFamilyLabel(modelEntry.family)} · {modelShortName(modelEntry.model.id)}
                </div>
                <div style={{ display: "flex" }}>
                  {modelEntry.tasks}×{modelEntry.attempts}
                </div>
              </div>
              {ranked.map((row) => {
                const isEve = isReferenceHarness(row.harness);
                return (
                  <div
                    key={row.harness}
                    style={{
                      alignItems: "center",
                      borderTop: "1px solid #1f1f1f",
                      color: isEve ? "white" : "#a1a1a1",
                      display: "flex",
                      fontSize: 20,
                      fontWeight: isEve ? 500 : 400,
                      height: 36,
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ display: "flex", flex: 1 }}>{row.harness}</div>
                    <div
                      style={{
                        color: "#777777",
                        display: "flex",
                        fontSize: 16,
                        justifyContent: "flex-end",
                        width: 110,
                      }}
                    >
                      {formatDurationMs(row.latencyP50Ms)}
                    </div>
                    <div
                      style={{
                        color: isEve ? "#4ade80" : "#d4d4d4",
                        display: "flex",
                        justifyContent: "flex-end",
                        width: 130,
                      }}
                    >
                      {formatPercent(row.resolveRate.estimate)} ({row.resolved}/{row.attempts})
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
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
