import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { GradientBorder } from "./gradient-border";

interface InteropFile {
  fileName: string;
  lang: string;
  code: string;
}

const FILES: InteropFile[] = [
  {
    fileName: "next.config.ts",
    lang: "typescript",
    code: `import { withEve } from "eve/next";

const nextConfig = {};

// Agent + app: one dev server, one deploy.
export default withEve(nextConfig);`,
  },
  {
    fileName: "app/chat.tsx",
    lang: "tsx",
    code: `"use client";
import { useEveAgent } from "eve/react";

export function Chat() {
  // Same-origin routes, found automatically.
  const agent = useEveAgent();
  // agent.messages, agent.sendMessage, ...
}`,
  },
];

async function renderCode(file: InteropFile) {
  return highlight(file.code, {
    lang: file.lang,
    theme: geistShikiTheme,
    components: {
      pre: ({ children, ...props }: ComponentProps<"pre">) => (
        <CodeBlock
          {...props}
          className={cn(props.className, "rounded-none border-0 bg-transparent px-0 py-4")}
        >
          {children}
        </CodeBlock>
      ),
    },
  });
}

export async function NextjsInterop() {
  const rendered = await Promise.all(FILES.map(renderCode));

  return (
    <section className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-medium! text-heading-32 tracking-tighter text-gray-1000 sm:text-heading-40">
          Works natively with Next.js
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Wrap your config with <span className="text-gray-1000">withEve()</span> and the agent
          mounts into your existing app. Same dev server, same deploy.{" "}
          <span className="text-gray-1000">useEveAgent()</span> finds its routes on its own, so
          there's no CORS to configure and no URL env vars to keep in sync.
        </p>

        {/* A single gradient-bordered frame around both code blocks. */}
        <div className="relative mt-16 rounded-xl p-5">
          <GradientBorder />
          <div className="grid gap-4 md:grid-cols-2">
            {FILES.map((file, i) => (
              <div key={file.fileName} className="overflow-hidden rounded-lg material-small">
                <div className="flex h-12 items-center gap-2 border-b px-4">
                  <span className="text-sm text-gray-1000">{file.fileName}</span>
                </div>
                <div className="overflow-x-auto text-[13px] [&>div]:mb-0">{rendered[i]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
