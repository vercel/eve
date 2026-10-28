import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Highlights code to sit flush inside a homepage figure, without the CodeBlock's own chrome. */
export function highlightFlush(code: string, lang: string, lineNumbers = false) {
  return highlight(code, {
    lang,
    theme: geistShikiTheme,
    components: {
      pre: ({ children, ...props }: ComponentProps<"pre">) => (
        <CodeBlock
          {...props}
          {...(lineNumbers ? { "data-line-numbers": "true" } : {})}
          className={cn(
            props.className,
            "my-0 rounded-none border-0 bg-transparent p-0 [&>[data-section=content]]:rounded-none [&>[data-section=content]]:border-0",
            lineNumbers &&
              "[&_.line]:before:!mr-4 [&_.line]:before:!w-5 [&_.line]:before:!text-left",
            // Wrap long lines instead of scrolling horizontally. CodeBlock sizes each line to
            // its content at a fixed height, so both have to give way for wrapping to happen.
            "[&_pre]:overflow-x-hidden! [&_code]:w-full! [&_code]:min-w-0! [&_code]:[grid-template-columns:minmax(0,1fr)]! [&_.line]:h-auto! [&_.line]:min-h-5 [&_.line]:w-full! [&_.line]:whitespace-pre-wrap [&_.line]:[overflow-wrap:anywhere]",
            // Hang wrapped lines past the line number (its 20px width plus 16px gap).
            lineNumbers &&
              "[&_code_.line]:pl-14! [&_code_.line]:-indent-9 [&_code_.line]:before:indent-0",
          )}
        >
          {children}
        </CodeBlock>
      ),
    },
  });
}
