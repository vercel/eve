"use client";

import { createCodePlugin } from "@streamdown/code";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { isValidElement, type ReactNode, useMemo } from "react";
import { type Components, Streamdown } from "streamdown";
import { resolveReadmeHref } from "@/lib/templates/readme-links";

interface TemplateReadmeProps {
  readme: string;
  sourceRevisionHref: string;
}

export const TemplateReadme = ({ readme, sourceRevisionHref }: TemplateReadmeProps) => {
  const codePlugin = useMemo(
    () => createCodePlugin({ themes: [geistShikiTheme, geistShikiTheme] }),
    [],
  );
  const components = useMemo<Partial<Components>>(
    () => ({
      a: ({ href, ...props }) => {
        const resolvedHref = resolveReadmeHref(href, sourceRevisionHref);
        if (!resolvedHref) {
          return <span>{props.children}</span>;
        }
        const external = !resolvedHref.startsWith("#");
        return (
          <a
            {...props}
            href={resolvedHref}
            rel={external ? "noopener noreferrer" : undefined}
            target={external ? "_blank" : undefined}
          />
        );
      },
      h1: ({ children }) => (
        <h2
          className="mt-10 mb-4 text-heading-32 text-gray-1000 first:mt-0"
          id={headingId(children)}
        >
          {children}
        </h2>
      ),
      h2: ({ children }) => (
        <h3 className="mt-8 mb-3 text-heading-24 text-gray-1000" id={headingId(children)}>
          {children}
        </h3>
      ),
      h3: ({ children }) => (
        <h4 className="mt-6 mb-3 text-heading-20 text-gray-1000" id={headingId(children)}>
          {children}
        </h4>
      ),
      h4: ({ children }) => (
        <h5 className="mt-6 mb-3 text-heading-16 text-gray-1000" id={headingId(children)}>
          {children}
        </h5>
      ),
      img: () => null,
    }),
    [sourceRevisionHref],
  );

  return (
    <Streamdown
      className="min-w-0 text-gray-900 [&_a]:font-medium [&_a]:text-gray-1000 [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-gray-alpha-400 [&_blockquote]:border-l [&_blockquote]:pl-4 [&_code]:text-gray-1000 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_table]:my-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5"
      components={components}
      disallowedElements={["img"]}
      mode="static"
      plugins={{ code: codePlugin }}
      shikiTheme={[geistShikiTheme, geistShikiTheme]}
    >
      {readme}
    </Streamdown>
  );
};

const headingId = (children: ReactNode): string =>
  getText(children)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const getText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getText(node.props.children);
  }
  return "";
};
