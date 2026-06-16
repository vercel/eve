"use client";

import { createCodePlugin } from "@streamdown/code";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";

interface MarkdownProps {
  children: string;
}

/**
 * Renders static markdown (prose + fenced code) for integration detail
 * sections. Streamdown's utility classes are compiled via the `@source`
 * directive in `app/styles/geistdocs.css`, and `@streamdown/code` provides
 * Shiki syntax highlighting with the Geist theme.
 */
export const Markdown = ({ children }: MarkdownProps) => {
  const codePlugin = useMemo(
    () => createCodePlugin({ themes: [geistShikiTheme, geistShikiTheme] }),
    [],
  );

  return (
    <Streamdown
      className="text-gray-900 [&_a]:font-medium [&_a]:text-gray-1000 [&_a]:underline [&_a]:underline-offset-4 [&_code]:text-gray-1000 [&_li]:my-1 [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5"
      mode="static"
      plugins={{ code: codePlugin }}
      shikiTheme={[geistShikiTheme, geistShikiTheme]}
    >
      {children}
    </Streamdown>
  );
};
