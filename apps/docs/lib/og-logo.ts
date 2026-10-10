import {
  Children,
  type ComponentType,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

type LogoElementProps = { children?: ReactNode };

/**
 * Expands logo components into plain SVG elements. `next/og` renders function
 * components but drops `forwardRef` and `memo` ones, which Geistdocs logos use.
 */
export const resolveLogo = (node: ReactNode): ReactNode => {
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
  if (typeof element.type === "object" && "type" in element.type) {
    const { type } = element.type as { type: ComponentType<LogoElementProps> };
    return resolveLogo(createElement(type, element.props));
  }

  return cloneElement(element, element.props, Children.map(element.props.children, resolveLogo));
};
