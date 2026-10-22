import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import Link from "next/link";
import { cacheLife } from "next/cache";
import type { ComponentProps, JSX } from "react";
import { cn } from "@/lib/utils";

interface Capability {
  title: string;
  description: string;
  fileName: string;
  href: string;
  lang: "typescript" | "tsx";
  code: string;
  /** Spans the full grid width, with its copy beside the code on large screens. */
  featured?: boolean;
  /** Short notes on what the code does, shown on featured cards. */
  notes?: string[];
}

const CAPABILITIES: Capability[] = [
  {
    title: "Wait on people, webhooks, and timers",
    featured: true,
    notes: [
      "ctx.ask posts the question in the session's channel, such as a Slack thread.",
      'sleep("4h") is a durable timer. Nothing runs while it waits.',
      "Completed steps are recorded, so a restart replays them instead of deploying twice.",
    ],
    description:
      "A workflow tool can wait for days in the middle of a call, with deadlines and escalations. The turn parks without compute and resumes with the answer.",
    fileName: "agent/tools/deploy.ts",
    href: "/docs/tools/workflows",
    lang: "typescript",
    code: `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import { applyDeploy, pageOnCall } from "../lib/deploy";

export default defineWorkflowTool({
  description: "Deploy a service once someone approves.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    const pending = ctx.ask({
      prompt: \`Deploy \${service}?\`,
      display: "confirmation",
      options: [
        { id: "deploy", label: "Deploy" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    // No answer in 4 hours: page on-call, keep waiting.
    let answer = await Promise.race([pending, sleep("4h")]);
    if (answer === undefined) {
      await pageOnCall(service);
      answer = await pending;
    }
    const ok =
      answer.status === "answered" &&
      answer.optionId === "deploy";
    if (!ok) return { deployed: false };
    return { deployed: true, url: await applyDeploy(service) };
  },
});`,
  },
  {
    title: "Resolve capabilities per caller",
    description:
      "Pick the model, tools, skills, subagents, or connections when a session starts, based on who is calling.",
    fileName: "agent/agent.ts",
    href: "/docs/guides/dynamic-capabilities",
    lang: "typescript",
    code: `import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) => {
        const caller = ctx.session.auth.initiator;
        return caller?.attributes.plan === "enterprise"
          ? "anthropic/claude-opus-5.5"
          : "anthropic/claude-sonnet-5";
      },
    },
  }),
});`,
  },
  {
    title: "Observe every event",
    description:
      "Hooks run after eve records each runtime event. Write events to your own database, alert on failures, or feed analytics.",
    fileName: "agent/hooks/audit.ts",
    href: "/docs/guides/hooks",
    lang: "typescript",
    code: `import { defineHook } from "eve/hooks";
import { db, agentEvents } from "../lib/db";

export default defineHook({
  events: {
    async "*"(event, ctx) {
      await db.insert(agentEvents).values({
        id: event.meta.id,
        sessionId: ctx.session.id,
        type: event.type,
        at: event.meta.at,
      }).onConflictDoNothing();
    },
  },
});`,
  },
  {
    title: "Get typed results from your backend",
    description:
      "The client starts sessions, streams events, and returns structured output that matches your schema.",
    fileName: "lib/triage.ts",
    href: "/docs/guides/client/output-schema",
    lang: "typescript",
    code: `import { Client } from "eve/client";
import { z } from "zod";
import { getServiceToken } from "./auth";

const client = new Client({
  host: "https://support.acme.dev",
  auth: { bearer: async () => await getServiceToken() },
});

const { response } = await client.sessions.create({
  message: "Triage ticket #9013.",
  outputSchema: z.object({
    priority: z.enum(["low", "high", "urgent"]),
    team: z.string(),
  }),
});

const { data } = await response.result();
// data?.priority is "low" | "high" | "urgent"`,
  },
  {
    title: "Mount it in your app",
    description:
      "Wrap your Next.js config to run the app and agent with one dev command and deploy them as one project. The hook uses same-origin routes.",
    fileName: "app/chat.tsx",
    href: "/docs/guides/frontend/overview",
    lang: "tsx",
    code: `// next.config.ts: export default withEve(nextConfig);
"use client";
import { useEveAgent } from "eve/react";
import { Message } from "./message";

export function Chat() {
  const agent = useEveAgent();
  const send = (form: FormData) =>
    agent.send(String(form.get("text")));

  return (
    <form action={send}>
      {agent.data.messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      <input name="text" />
    </form>
  );
}`,
  },
];

/** Drops the code block's own frame so the code sits flush inside the card. */
const FLAT_CODE_BLOCK =
  "my-0! rounded-none border-0 bg-transparent px-0 [&_[data-section=content]]:rounded-none! [&_[data-section=content]]:border-0! [&_pre]:rounded-none! [&_pre]:bg-transparent!";

function renderCode(capability: Capability) {
  return highlight(capability.code, {
    lang: capability.lang,
    theme: geistShikiTheme,
    components: {
      pre: ({ children, ...props }: ComponentProps<"pre">) => (
        <CodeBlock {...props} className={cn(props.className, FLAT_CODE_BLOCK)}>
          {children}
        </CodeBlock>
      ),
    },
  });
}

export async function Programmable(): Promise<JSX.Element> {
  "use cache";
  cacheLife("max");

  const rendered = await Promise.all(CAPABILITIES.map(renderCode));

  return (
    <section className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="mx-auto max-w-3xl text-center text-heading-32 text-gray-1000 text-balance sm:text-heading-40">
          Start with files, take control in TypeScript
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          Files get an agent running. Each convention also has a TypeScript form, and the runtime
          gives you typed resolvers, hooks, workflow tools, and a client. eve runs the loop;
          everything around it is yours to program.
        </p>

        <div className="mt-16 grid gap-4 md:grid-cols-2">
          {CAPABILITIES.map((capability, index) => (
            <article
              className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-background-100",
                capability.featured &&
                  "md:col-span-2 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]",
              )}
              key={capability.title}
            >
              <div
                className={cn(
                  "flex flex-col border-b",
                  capability.featured && "lg:border-r lg:border-b-0",
                )}
              >
                <div className="flex flex-col gap-1.5 px-5 pt-5 pb-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-gray-1000 text-heading-16">{capability.title}</h3>
                    <Link
                      className="shrink-0 text-gray-900 text-label-13 transition-colors hover:text-gray-1000"
                      href={capability.href}
                      prefetch={true}
                    >
                      Docs
                      <span className="sr-only">: {capability.title}</span>
                    </Link>
                  </div>
                  <p className="text-gray-900 text-copy-14">{capability.description}</p>
                  {capability.notes ? (
                    <ul className="mt-3 flex list-none flex-col gap-2">
                      {capability.notes.map((note) => (
                        <li className="flex gap-2.5 text-gray-900 text-copy-14" key={note}>
                          <span
                            aria-hidden
                            className="mt-[0.55em] size-1 shrink-0 rounded-full bg-gray-700"
                          />
                          {note}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div
                  className={cn(
                    "flex h-10 items-center border-t px-5",
                    capability.featured && "lg:mt-auto",
                  )}
                >
                  <span className="truncate font-mono text-gray-900 text-label-12-mono">
                    {capability.fileName}
                  </span>
                </div>
              </div>
              <div className="min-w-0 grow text-[13px]">{rendered[index]}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
