import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import { ImageResponse } from "next/og";
import { PNG } from "pngjs";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { resolveLogo } from "../og-logo";
import type { Integration } from "./data";
import { logos } from "./logos";

const integrationOgImageSize = {
  width: 1200,
  height: 628,
};

type LogoElementProps = Record<string, unknown> & {
  children?: ReactNode;
  fill?: string;
  height?: number;
  preserveAspectRatio?: string;
  stroke?: string;
  viewBox?: string;
  width?: number;
};

const fitLogo = (node: ReactNode, maxWidth: number, maxHeight: number): ReactNode => {
  if (!isValidElement(node)) return node;

  const element = node as ReactElement<LogoElementProps>;
  const viewBox = element.props.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    return cloneElement(element, { ...element.props, height: maxHeight, width: maxWidth });
  }

  const [, , viewBoxWidth, viewBoxHeight] = viewBox;
  if (viewBoxWidth <= 0 || viewBoxHeight <= 0) return element;

  const aspectRatio = viewBoxWidth / viewBoxHeight;
  const width = Math.min(maxWidth, maxHeight * aspectRatio);
  const height = width / aspectRatio;
  return cloneElement(element, {
    ...element.props,
    height,
    preserveAspectRatio: "xMidYMid meet",
    width,
  });
};

interface RasterizedLogo {
  darkSilhouette: boolean;
  height: number;
  inkCoverage: number;
  src: string;
  width: number;
}

interface SizedLogo {
  height: number;
  src: string;
  width: number;
}

const pixelInk = (image: PNG, offset: number): number => {
  const red = image.data[offset];
  const green = image.data[offset + 1];
  const blue = image.data[offset + 2];
  const alpha = image.data[offset + 3];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return (alpha * luminance) / 255;
};

const cropLogo = (image: PNG): PNG => {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (pixelInk(image, offset) <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return image;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = new PNG({ height, width });
  PNG.bitblt(image, cropped, minX, minY, width, height, 0, 0);
  return cropped;
};

const contrastLogo = (node: ReactNode): ReactNode => {
  if (!isValidElement(node)) return node;

  const element = node as ReactElement<LogoElementProps>;
  if (element.type === "mask") return element;

  const liftDarkColor = (color: string | undefined): string | undefined => {
    if (!color || color === "none" || color === "currentColor") return color;
    if (color === "black") return "#b4b4b4";

    const hex = color.startsWith("#") ? color.slice(1) : "";
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join("") : hex;
    if (!/^[\da-f]{6}$/iu.test(expanded)) return color;

    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(expanded.slice(offset, offset + 2), 16),
    );
    const [red, green, blue] = channels as [number, number, number];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (luminance >= 110) return color;

    const lift = (180 - luminance) / (255 - luminance);
    return `#${channels
      .map((channel) =>
        Math.round(channel + (255 - channel) * lift)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  };

  const props = element.props;
  return cloneElement(
    element,
    { ...props, fill: liftDarkColor(props.fill), stroke: liftDarkColor(props.stroke) },
    Children.map(props.children, contrastLogo),
  );
};

// A logo whose outer edge is dark disappears on the black OG canvas. Logos with
// dark details inside their own colored shape are fine as drawn.
const hasDarkSilhouette = (image: PNG): boolean => {
  const alphaAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= image.width || y >= image.height
      ? 0
      : image.data[(y * image.width + x) * 4 + 3]!;
  let edge = 0;
  let darkEdge = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(x, y) < 200) continue;
      if (
        alphaAt(x - 1, y) > 50 &&
        alphaAt(x + 1, y) > 50 &&
        alphaAt(x, y - 1) > 50 &&
        alphaAt(x, y + 1) > 50
      ) {
        continue;
      }
      edge += 1;
      const offset = (y * image.width + x) * 4;
      const luminance =
        0.2126 * image.data[offset]! +
        0.7152 * image.data[offset + 1]! +
        0.0722 * image.data[offset + 2]!;
      if (luminance < 60) darkEdge += 1;
    }
  }
  return edge > 0 && darkEdge / edge > 0.5;
};

const rasterizeLogo = async (logo: ReactNode): Promise<RasterizedLogo> => {
  const response = new ImageResponse(
    <div
      style={{
        alignItems: "center",
        color: "white",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      {fitLogo(logo, 480, 480)}
    </div>,
    { height: 512, width: 512 },
  );
  const image = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  const darkSilhouette = hasDarkSilhouette(image);
  const cropped = cropLogo(image);
  let ink = 0;
  for (let offset = 0; offset < cropped.data.length; offset += 4) {
    ink += pixelInk(cropped, offset) / 255;
  }

  return {
    darkSilhouette,
    height: cropped.height,
    inkCoverage: ink / (cropped.width * cropped.height),
    src: `data:image/png;base64,${PNG.sync.write(cropped).toString("base64")}`,
    width: cropped.width,
  };
};

const balanceLogoWeight = (logo: RasterizedLogo, referenceCoverage: number): SizedLogo => {
  const aspectRatio = logo.width / logo.height;
  const fittedWidth = Math.min(180, 132 * aspectRatio);
  const fittedHeight = fittedWidth / aspectRatio;
  if (logo.inkCoverage <= 0) {
    return { height: fittedHeight, src: logo.src, width: fittedWidth };
  }

  // Dampened density normalization keeps solid marks from overpowering the
  // wordmark without making compact logos feel disproportionately small.
  const densityScale = Math.min(1, (referenceCoverage / logo.inkCoverage) ** 0.25);
  return {
    height: fittedHeight * densityScale,
    src: logo.src,
    width: fittedWidth * densityScale,
  };
};

let eveInkCoverage: Promise<number> | undefined;

const getEveInkCoverage = (): Promise<number> => {
  eveInkCoverage ??= rasterizeLogo(resolveLogo(<LogoEveSvg height={18} />)).then(
    (logo) => logo.inkCoverage,
  );
  return eveInkCoverage;
};

const rasterizedLogos = new Map<string, Promise<RasterizedLogo>>();

const getRasterizedLogo = (integration: Integration): Promise<RasterizedLogo> => {
  const cached = rasterizedLogos.get(integration.logo);
  if (cached) return cached;

  const Logo = logos[integration.logo];
  const resolvedLogo = resolveLogo(<Logo aria-hidden />);
  const rasterized = rasterizeLogo(resolvedLogo).then((logo) =>
    logo.darkSilhouette ? rasterizeLogo(contrastLogo(resolvedLogo)) : logo,
  );
  rasterizedLogos.set(integration.logo, rasterized);
  return rasterized;
};

export const createIntegrationOgImage = async (
  integration: Integration,
): Promise<ImageResponse> => {
  const [rasterizedLogo, referenceCoverage] = await Promise.all([
    getRasterizedLogo(integration),
    getEveInkCoverage(),
  ]);
  const integrationLogo = balanceLogoWeight(rasterizedLogo, referenceCoverage);

  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "black",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        padding: 60,
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            color: "white",
            display: "flex",
            height: 132,
            justifyContent: "flex-end",
            width: 240,
          }}
        >
          {resolveLogo(<LogoEveSvg height={70} />)}
        </div>
        <div
          style={{
            alignItems: "center",
            color: "white",
            display: "flex",
            fontSize: 56,
            fontWeight: 300,
            height: 132,
            justifyContent: "center",
            margin: "0 46px",
          }}
        >
          +
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            height: 132,
            justifyContent: "flex-start",
            width: 240,
          }}
        >
          <img
            alt=""
            height={integrationLogo.height}
            src={integrationLogo.src}
            width={integrationLogo.width}
          />
        </div>
      </div>
    </div>,
    integrationOgImageSize,
  );
};
