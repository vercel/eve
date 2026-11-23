import { ImageResponse } from "next/og";
import { titleArtHeight, titleArtWidth } from "./title-art-data";
import { titleStillSvg } from "./title-art";
import { challengeTitle } from "./title-stencils";

export const alt = challengeTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const artwork = `data:image/svg+xml;base64,${Buffer.from(titleStillSvg).toString("base64")}`;

export default function ChallengeOpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: "#fff",
      }}
    >
      <img alt="" src={artwork} width={titleArtWidth} height={titleArtHeight} />
    </div>,
    size,
  );
}
