"use client";

import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Clock,
  FileText,
  MessageSquare,
  Plug,
  Settings,
  Terminal,
  Wrench,
} from "lucide-react";
import { motion, useInView } from "motion/react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

function Kw({ children }: { children: ReactNode }) {
  return <span className="text-[#cf222e] dark:text-[#ff7b72]">{children}</span>;
}
function Str({ children }: { children: ReactNode }) {
  return <span className="text-[#0a3069] dark:text-[#a5d6ff]">{children}</span>;
}
function Fn({ children }: { children: ReactNode }) {
  return <span className="text-[#8250df] dark:text-[#d2a8ff]">{children}</span>;
}
function Ty({ children }: { children: ReactNode }) {
  return <span className="text-[#0550ae] dark:text-[#79c0ff]">{children}</span>;
}
function Pl({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ?? "text-gray-1000"}>{children}</span>;
}

interface TreeItem {
  name: string;
  fileName: string;
  icon: LucideIcon;
  color: string;
  description: string;
  codeHighlighted: ReactNode;
  indent: number;
}

const treeItems: TreeItem[] = [
  {
    name: "agent.ts",
    fileName: "agent.ts",
    icon: Settings,
    color: "text-purple-600",
    description: "Model and runtime configuration.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>defineAgent</Fn>
        <Pl>{" }"}</Pl> <Kw>from</Kw> <Str>{'"eve"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>defineAgent</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Ty>model</Ty>
        <Pl>:</Pl> <Str>{'"openai/gpt-5.4-mini"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "instructions.md",
    fileName: "instructions.md",
    icon: FileText,
    color: "text-green-600",
    description: "Always-on instructions. The agent's core identity.",
    codeHighlighted: (
      <>
        <Pl className="text-gray-1000 font-semibold">{"# Identity"}</Pl>
        {"\n"}
        {"\n"}
        <Pl>You are an expert weather assistant.</Pl>
        {"\n"}
        <Pl>You can fetch the weather for any</Pl>
        {"\n"}
        <Pl>city in the world.</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "skills/",
    fileName: "skills/research.md",
    icon: FileText,
    color: "text-amber-600",
    description: "On-demand procedures loaded only when relevant.",
    codeHighlighted: (
      <>
        <Pl className="text-gray-600">{"---"}</Pl>
        {"\n"}
        <Ty>name</Ty>
        <Pl>:</Pl> <Str>research</Str>
        {"\n"}
        <Ty>description</Ty>
        <Pl>:</Pl> <Str>Research unfamiliar topics</Str>
        {"\n"}
        <Pl className="text-gray-600">{"---"}</Pl>
        {"\n"}
        {"\n"}
        <Pl>When the task is novel or ambiguous,</Pl>
        {"\n"}
        <Pl>gather evidence first, then answer.</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "tools/",
    fileName: "tools/get_weather.ts",
    icon: Wrench,
    color: "text-orange-600",
    description: "Typed integrations exposed to the model. File name becomes the tool name.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>defineTool</Fn>
        <Pl>{" }"}</Pl> <Kw>from</Kw> <Str>{'"eve/tools"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        <Kw>import</Kw> <Pl>z</Pl> <Kw>from</Kw> <Str>{'"zod"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>defineTool</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Ty>description</Ty>
        <Pl>:</Pl> <Str>{'"Get the weather for a city"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        {"  "}
        <Ty>inputSchema</Ty>
        <Pl>:</Pl> <Pl>z.</Pl>
        <Fn>object</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"    "}
        <Ty>cityName</Ty>
        <Pl>:</Pl> <Pl>z.</Pl>
        <Fn>string</Fn>
        <Pl>(),</Pl>
        {"\n"}
        {"  "}
        <Pl>{"}),"}</Pl>
        {"\n"}
        {"  "}
        <Kw>async</Kw> <Fn>execute</Fn>
        <Pl>{"(input) {"}</Pl>
        {"\n"}
        {"    "}
        <Kw>const</Kw> <Pl>res =</Pl> <Kw>await</Kw> <Fn>fetch</Fn>
        <Pl>(</Pl>
        {"\n"}
        {"      "}
        <Str>{"`${"}</Str>
        <Pl>process.env.WEATHER_API_URL</Pl>
        <Str>{"}/current?city=${"}</Str>
        <Pl>input.cityName</Pl>
        <Str>{"}`"}</Str>
        {"\n"}
        {"    "}
        <Pl>);</Pl>
        {"\n"}
        {"    "}
        <Kw>const</Kw> <Pl>data =</Pl> <Kw>await</Kw> <Pl>res.</Pl>
        <Fn>json</Fn>
        <Pl>();</Pl>
        {"\n"}
        {"    "}
        <Kw>return</Kw> <Pl>data.current_condition[</Pl>
        <Str>0</Str>
        <Pl>];</Pl>
        {"\n"}
        {"  "}
        <Pl>{"},"}</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "sandbox/",
    fileName: "sandbox/sandbox.ts",
    icon: Terminal,
    color: "text-red-600",
    description: "Isolated compute environments with lifecycle hooks.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>defineSandbox</Fn>
        <Pl>{" }"}</Pl> <Kw>from</Kw>
        {"\n"}
        {"  "}
        <Str>{'"eve/sandbox"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>defineSandbox</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Kw>async</Kw> <Fn>bootstrap</Fn>
        <Pl>{"({ sandbox }) {"}</Pl>
        {"\n"}
        {"    "}
        <Kw>await</Kw> <Pl>sandbox.</Pl>
        <Fn>run</Fn>
        <Pl>(</Pl>
        {"\n"}
        {"      "}
        <Str>{'"git clone repo /workspace"'}</Str>
        {"\n"}
        {"    "}
        <Pl>);</Pl>
        {"\n"}
        {"  "}
        <Pl>{"},"}</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "channels/",
    fileName: "channels/slack.ts",
    icon: MessageSquare,
    color: "text-cyan-600",
    description: "HTTP, Slack, and custom delivery surfaces.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>slackChannel</Fn>
        <Pl>{" }"}</Pl> <Kw>from</Kw>
        {"\n"}
        {"  "}
        <Str>{'"eve/channels/slack"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>slackChannel</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Ty>botName</Ty>
        <Pl>:</Pl> <Str>{'"my-agent"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "connections/",
    fileName: "connections/linear.ts",
    icon: Plug,
    color: "text-pink-600",
    description: "External MCP services.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>defineMcpClientConnection</Fn>
        <Pl>{" }"}</Pl>
        {"\n"}
        {"  "}
        <Kw>from</Kw> <Str>{'"eve/connections"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>defineMcpClientConnection</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Ty>url</Ty>
        <Pl>:</Pl> <Str>{'"https://mcp.linear.app/mcp"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "subagents/",
    fileName: "subagents/researcher/agent.ts",
    icon: Bot,
    color: "text-indigo-600",
    description: "Specialist child agents.",
    codeHighlighted: (
      <>
        <Kw>import</Kw> <Pl>{"{ "}</Pl>
        <Fn>defineAgent</Fn>
        <Pl>{" }"}</Pl> <Kw>from</Kw>
        {"\n"}
        {"  "}
        <Str>{'"eve"'}</Str>
        <Pl>;</Pl>
        {"\n"}
        {"\n"}
        <Kw>export default</Kw> <Fn>defineAgent</Fn>
        <Pl>{"({"}</Pl>
        {"\n"}
        {"  "}
        <Ty>description</Ty>
        <Pl>:</Pl> <Str>{'"Investigate questions"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        {"  "}
        <Ty>model</Ty>
        <Pl>:</Pl> <Str>{'"openai/gpt-5.4"'}</Str>
        <Pl>,</Pl>
        {"\n"}
        <Pl>{"});"}</Pl>
      </>
    ),
    indent: 1,
  },
  {
    name: "schedules/",
    fileName: "schedules/daily-report.md",
    icon: Clock,
    color: "text-emerald-600",
    description: "Recurring cron jobs.",
    codeHighlighted: (
      <>
        <Pl className="text-gray-600">{"---"}</Pl>
        {"\n"}
        <Ty>cron</Ty>
        <Pl>:</Pl> <Str>{'"0 8 * * *"'}</Str>
        {"\n"}
        <Pl className="text-gray-600">{"---"}</Pl>
        {"\n"}
        {"\n"}
        <Pl>Send the user a daily weather</Pl>
        {"\n"}
        <Pl>digest for their saved cities.</Pl>
      </>
    ),
    indent: 1,
  },
];

const CODE_BOX_HEIGHT = 280;

export function FileTree() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selected = treeItems[selectedIndex];

  return (
    <section className="px-4 pb-24 pt-16 sm:px-12" ref={ref}>
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-bold tracking-tighter text-gray-1000 sm:text-4xl">
          An agent is a directory
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Define instructions and skills in markdown, tools in TypeScript, and deploy. The framework
          compiles the directory, wires up durable workflows, and connects channels.
        </p>
        <div className="mt-20 grid gap-8 md:grid-cols-[240px_1fr]">
          <div className="space-y-0.5">
            <div className="mb-3 font-mono text-xs font-semibold text-gray-900">agent/</div>
            {treeItems.map((item, i) => (
              <motion.button
                key={item.name}
                type="button"
                initial={{ opacity: 0, x: -16 }}
                animate={isInView ? { opacity: 1, x: 0 } : {}}
                transition={{
                  delay: i * 0.06,
                  duration: 0.4,
                  ease: [0.22, 1, 0.36, 1],
                }}
                onClick={() => setSelectedIndex(i)}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  selectedIndex === i ? "bg-gray-100" : "hover:bg-gray-100/40"
                }`}
                style={{ paddingLeft: `${item.indent * 16 + 4}px` }}
              >
                <item.icon className={`h-4 w-4 shrink-0 ${item.color}`} />
                <span
                  className={`font-mono text-sm ${
                    selectedIndex === i ? "text-gray-1000" : "text-gray-900"
                  }`}
                >
                  {item.name}
                </span>
              </motion.button>
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <div className="min-h-[48px]">
              <motion.div
                key={selectedIndex}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.15 }}
              >
                <div className="flex items-center gap-2">
                  <selected.icon className={`h-5 w-5 ${selected.color}`} />
                  <span className="font-mono text-base font-semibold text-gray-1000">
                    {selected.fileName}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-900">{selected.description}</p>
              </motion.div>
            </div>

            <motion.div
              key={`code-${selectedIndex}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}
              className="overflow-y-auto rounded-md border bg-background-100 p-5"
              style={{ height: CODE_BOX_HEIGHT }}
            >
              <pre className="font-mono text-[13px] leading-6 whitespace-pre-wrap">
                {selected.codeHighlighted}
              </pre>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
