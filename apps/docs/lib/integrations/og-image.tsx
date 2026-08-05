import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import { ImageResponse } from "next/og";
import { PNG } from "pngjs";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
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

const resolveLogo = (node: ReactNode): ReactNode => {
  if (!isValidElement(node)) return node;

  const element = node as ReactElement<LogoElementProps>;
  if (element.type === "title" || element.type === "desc") return null;
  if (typeof element.type === "function") {
    const component = element.type as (props: LogoElementProps) => ReactNode;
    return resolveLogo(component(element.props));
  }
  if (typeof element.type === "object" && "render" in element.type) {
    const component = element.type as { render: (props: LogoElementProps) => ReactNode };
    return resolveLogo(component.render(element.props));
  }

  return cloneElement(element, element.props, Children.map(element.props.children, resolveLogo));
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
  height: number;
  src: string;
  width: number;
}

const cropLogo = (image: PNG): PNG => {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha <= 8) continue;
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

const rasterizeLogo = async (logo: ReactNode): Promise<RasterizedLogo> => {
  const response = new ImageResponse(
    <div
      style={{
        alignItems: "center",
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
  const cropped = cropLogo(image);
  const aspectRatio = cropped.width / cropped.height;
  const width = Math.min(180, 132 * aspectRatio);
  const height = width / aspectRatio;

  return {
    height,
    src: `data:image/png;base64,${PNG.sync.write(cropped).toString("base64")}`,
    width,
  };
};

const collectLogoColors = (node: ReactNode, colors = new Set<string>()): Set<string> => {
  if (!isValidElement(node)) return colors;

  const { children, fill, stroke } = (node as ReactElement<LogoElementProps>).props;
  for (const color of [fill, stroke]) {
    if (color && color !== "none" && color !== "currentColor") colors.add(color.toLowerCase());
  }
  Children.forEach(children, (child) => collectLogoColors(child, colors));
  return colors;
};

const grayscaleColor = (color: string): string => {
  const normalized = color.toLowerCase();
  if (normalized === "currentcolor") return "white";
  if (normalized === "white") return "black";
  if (normalized === "black") return "white";

  const hex = normalized.slice(1);
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join("") : hex;
  if (!/^[\da-f]{6}$/.test(expanded)) return "white";

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const gray = 255 - Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  return `rgb(${gray}, ${gray}, ${gray})`;
};

const recolorLogo = (node: ReactNode, preserveTones: boolean): ReactNode => {
  if (!isValidElement(node)) return node;

  const element = node as ReactElement<LogoElementProps>;
  const props = element.props;
  const recolor = (color: string | undefined): string | undefined => {
    if (!color || color === "none") return color;
    return preserveTones ? grayscaleColor(color) : "white";
  };

  return cloneElement(
    element,
    { ...props, fill: recolor(props.fill), stroke: recolor(props.stroke) },
    Children.map(props.children, (child) => recolorLogo(child, preserveTones)),
  );
};

const rasterizedLogos = new Map<string, Promise<RasterizedLogo>>();

const getRasterizedLogo = (integration: Integration): Promise<RasterizedLogo> => {
  const cached = rasterizedLogos.get(integration.logo);
  if (cached) return cached;

  const Logo = logos[integration.logo];
  const resolvedLogo = resolveLogo(<Logo aria-hidden />);
  const recoloredLogo = recolorLogo(resolvedLogo, collectLogoColors(resolvedLogo).size > 1);
  const rasterized = rasterizeLogo(recoloredLogo);
  rasterizedLogos.set(integration.logo, rasterized);
  return rasterized;
};

export const createIntegrationOgImage = async (
  integration: Integration,
): Promise<ImageResponse> => {
  const integrationLogo = await getRasterizedLogo(integration);

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
          border: "2px solid #333333",
          borderRadius: 20,
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
          <LogoEve height={70} />
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
