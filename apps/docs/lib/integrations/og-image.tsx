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
  stroke?: string;
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
  const resolvedLogo = resolveLogo(<Logo aria-hidden height={132} width={180} />);
  const integrationLogo = recolorLogo(resolvedLogo, collectLogoColors(resolvedLogo).size > 1);

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
