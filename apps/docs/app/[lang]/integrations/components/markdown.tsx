"use client";

import { createCodePlugin } from "@streamdown/code";
import { track } from "@vercel/analytics";
import Link from "next/link";
import { useMemo } from "react";
import { type Components, Streamdown } from "streamdown";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { analyticsEvents } from "@/lib/analytics/events";

export type IntegrationSection = "configure" | "install" | "quick_start";

interface MarkdownProps {
  analytics?: {
    integration: string;
    section: IntegrationSection;
  };
  children: string;
}

/**
 * Render internal links with Next's client
 * router and external links with a plain anchor. This overrides Streamdown's
 * default anchor, whose `linkSafety` treats every link — internal ones
 * included — as external and interrupts navigation with a confirmation modal.
 */
const components: Partial<Components> = {
  a: ({ href, ...props }) =>
    typeof href === "string" && href.startsWith("/") ? (
      <Link href={href} {...props} />
    ) : (
      <a href={href} rel="noreferrer" target="_blank" {...props} />
    ),
};

/**
 * Renders static markdown (prose + fenced code) for integration detail
 * sections. Streamdown's utility classes are compiled via the `@source`
 * directive in `app/styles/geistdocs.css`, and `@streamdown/code` provides
 * Shiki syntax highlighting with the Geist theme.
 */
export const Markdown = ({ analytics, children }: MarkdownProps) => {
  const codePlugin = useMemo(
    () => createCodePlugin({ themes: [geistShikiTheme, geistShikiTheme] }),
    [],
  );

  return (
    <div
      onClick={(event) => {
        if (
          analytics &&
          event.target instanceof Element &&
          event.target.closest('[data-streamdown="code-block-copy-button"]')
        ) {
          track(analyticsEvents.integrationCodeCopied, analytics);
        }
      }}
    >
      <Streamdown
        className="text-gray-900 [&_a]:font-medium [&_a]:text-gray-1000 [&_a]:underline [&_a]:underline-offset-4 [&_code]:text-gray-1000 [&_li]:my-1 [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5"
        components={components}
        mode="static"
        plugins={{ code: codePlugin }}
        shikiTheme={[geistShikiTheme, geistShikiTheme]}
      >
        {children}
      </Streamdown>
    </div>
  );
};
