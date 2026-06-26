import { Badge } from "@vercel/geistdocs/components/badge";
import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps } from "react";
import { IconAcronymTs } from "@/components/geistcn-icons";
import { cn } from "@/lib/utils";

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

const BENEFITS = ["One dev server", "Same-origin, no CORS", "One deploy"];

async function renderCode(file: InteropFile) {
  return highlight(file.code, {
    lang: file.lang,
    theme: geistShikiTheme,
    components: {
      pre: ({ children, ...props }: ComponentProps<"pre">) => (
        <CodeBlock
          {...props}
          className={cn(props.className, "rounded-none border-0 bg-transparent p-4")}
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
    <section className="px-4 py-24 sm:px-12">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold tracking-tighter text-gray-1000 sm:text-4xl">
          Runs inside your Next.js app
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Wrap your config with <span className="text-gray-1000">withEve()</span> and the agent runs
          alongside your app. <span className="text-gray-1000">useEveAgent()</span> finds the
          mounted routes on its own — no CORS to configure and no URL env vars to keep in sync.
        </p>

        <div className="mt-16 grid gap-4 md:grid-cols-2">
          {FILES.map((file, i) => (
            <div
              key={file.fileName}
              className="overflow-hidden rounded-xl border bg-background-100 shadow-sm"
            >
              <div className="flex h-12 items-center gap-2 border-b px-4">
                <IconAcronymTs aria-hidden className="shrink-0" color="gray-900" size={16} />
                <span className="text-sm text-gray-1000">{file.fileName}</span>
              </div>
              <div className="overflow-x-auto text-[13px] [&>div]:mb-0">{rendered[i]}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {BENEFITS.map((benefit) => (
            <Badge
              key={benefit}
              variant="secondary"
              className="font-mono uppercase tracking-[0.1em] text-gray-900"
            >
              {benefit}
            </Badge>
          ))}
        </div>
      </div>
    </section>
  );
}
