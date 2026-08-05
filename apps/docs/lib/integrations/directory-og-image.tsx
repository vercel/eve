import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

const integrationsDirectoryOgImageSize = {
  width: 1200,
  height: 628,
};

const fontDirectory = join(process.cwd(), "app/[lang]/og/[...slug]");
const fonts = Promise.all([
  readFile(join(fontDirectory, "geist-sans-regular.ttf")),
  readFile(join(fontDirectory, "geist-sans-semibold.ttf")),
]);

export const createIntegrationsDirectoryOgImage = async (): Promise<ImageResponse> => {
  const [regularFont, semiboldFont] = await fonts;

  return new ImageResponse(
    <div
      style={{
        background: "black",
        display: "flex",
        fontFamily: "Geist",
        height: "100%",
        position: "relative",
        width: "100%",
      }}
    >
      <svg
        fill="none"
        height="628"
        style={{ inset: 0, position: "absolute" }}
        viewBox="0 0 1200 628"
        width="1200"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M1135.17 213.99H995.554L898.062 334.984H867.16L983.038 190.984H1135.17V213.99Z"
          fill="white"
        />
        <path d="M1135.17 311.919V334.925H1010.54V311.919H1135.17Z" fill="white" />
        <path d="M800.63 334.921H676V311.915H800.63V334.921Z" fill="white" />
        <path d="M781.034 273.983H676V250.981H781.034V273.983Z" fill="white" />
        <path d="M1135.17 273.983H1030.13V250.981H1135.17V273.983Z" fill="white" />
        <path d="M881.178 213.99H676V190.984H881.178V213.99Z" fill="white" />
        <rect
          fill="url(#eve-logo-fade)"
          height="264.03"
          transform="rotate(-45 546 304.914)"
          width="410"
          x="546"
          y="304.914"
        />
        <path d="M92 47L124 103H60L92 47Z" fill="white" />
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="eve-logo-fade"
            x1="751"
            x2="751"
            y1="304.914"
            y2="568.943"
          >
            <stop offset="0.144231" stopColor="black" />
            <stop offset="1" stopColor="black" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <div
        style={{
          color: "#A0A0A0",
          display: "flex",
          fontSize: 26.4,
          fontWeight: 500,
          left: 60,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          position: "absolute",
          top: 192,
        }}
      >
        eve
      </div>
      <div
        style={{
          color: "white",
          display: "flex",
          fontSize: 80,
          fontWeight: 400,
          left: 60,
          letterSpacing: "-0.06em",
          lineHeight: 1,
          position: "absolute",
          top: 242,
          whiteSpace: "nowrap",
        }}
      >
        Integrations
      </div>
    </div>,
    {
      ...integrationsDirectoryOgImageSize,
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
