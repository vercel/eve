import { LogoEve } from "@vercel/geistdocs/assets/logos/logo-eve";
import { ImageResponse } from "next/og";
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

export const createIntegrationOgImage = (integration: Integration): ImageResponse => {
  const Logo = logos[integration.logo];
  const resolvedLogo = resolveLogo(<Logo aria-hidden />);
  const recoloredLogo = recolorLogo(resolvedLogo, collectLogoColors(resolvedLogo).size > 1);
  const integrationLogo = fitLogo(recoloredLogo, 180, 132);

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
            justifyContent: "center",
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
            justifyContent: "center",
            width: 240,
          }}
        >
          {integrationLogo}
        </div>
      </div>
    </div>,
    integrationOgImageSize,
  );
};
