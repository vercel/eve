import { IconFolderOpen, IconSparkles } from "@vercel/geistdocs/assets/icons";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { FeatureCard, GrayBadge, RuledList, ruledRow, Visual } from "./control-visual";
import { HomeSection } from "./section";

// The agent directory: instructions.md alone is a complete agent, and every other entry is
// an optional building block.
const ENTRIES = [
  { name: "instructions.md", required: true },
  { name: "agent.ts", required: false },
  { name: "skills/", required: false },
  { name: "tools/", required: false },
  { name: "channels/", required: false },
];

function AgentFolder() {
  return (
    <Visual caption="An agent directory: instructions.md is required, and agent.ts, skills, tools, and channels are optional.">
      {/* The fade sits on a frame-sized layer so it ends at the frame, not the list. */}
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_68%,transparent)]">
        <RuledList header={<span className="font-mono">agent/</span>}>
          {ENTRIES.map(({ name, required }) => (
            <li className={ruledRow} key={name}>
              <span
                className={cn(
                  "w-[11em] whitespace-nowrap font-mono text-[0.75em] leading-none",
                  required ? "text-gray-1000" : "text-gray-900",
                )}
              >
                {name}
              </span>
              <GrayBadge>{required ? "Required" : "Optional"}</GrayBadge>
            </li>
          ))}
        </RuledList>
      </div>
    </Visual>
  );
}

// A dynamic tool file in the same frame as the folder: the code that runs each session, then
// what it returned for this one.
const CODE = [
  "export default defineDynamic(async (ctx) => {",
  "  const tables = await listTables(ctx.session);",
  "  return toolsFor(tables);",
  "});",
];
const RESOLVED = ["query_orders", "query_users", "query_invoices"];

function DynamicTool() {
  return (
    <Visual caption="A dynamic tool file runs defineDynamic each session. For this session it returned query_orders, query_users, and query_invoices, one tool per table the caller can read.">
      <div className="absolute top-[calc(8cqw+1em)] right-0 left-[8%] select-none pl-[1em] text-[4.4cqw]">
        <div className="flex flex-col gap-[0.875em]">
          <span className="flex h-[0.8125em] items-center font-mono text-[0.8125em] text-gray-900 leading-none">
            tools/query.ts
          </span>
          <pre className="m-0 border-gray-alpha-400 border-t pt-[0.75em] font-mono text-[0.625em] text-gray-900 leading-[1.6] [mask-image:linear-gradient(to_right,black_70%,transparent_95%)]">
            {CODE.map((line) => (
              <span className="block whitespace-pre" key={line}>
                {line.startsWith("export default defineDynamic") ? (
                  <>
                    {"export default "}
                    <span className="text-gray-1000">defineDynamic</span>
                    {line.slice("export default defineDynamic".length)}
                  </>
                ) : (
                  line
                )}
              </span>
            ))}
          </pre>
          <div className="flex items-center gap-[0.375em] overflow-hidden border-gray-alpha-400 border-t pt-[0.75em] [mask-image:linear-gradient(to_right,black_70%,transparent_95%)]">
            <span className="mr-[0.25em] shrink-0 whitespace-nowrap text-[0.625em] text-gray-900 leading-none">
              This session
            </span>
            {RESOLVED.map((tool) => (
              <GrayBadge key={tool}>
                <span className="font-mono">{tool}</span>
              </GrayBadge>
            ))}
          </div>
        </div>
      </div>
    </Visual>
  );
}

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="Author an agent as a folder of files anyone can read, or build its tools, skills, and instructions in code for each session."
      title="How it works"
    >
      <ul className="m-0 grid list-none gap-x-6 gap-y-16 p-0 md:grid-cols-2">
        <FeatureCard
          href="/docs/concepts/project-structure"
          icon={<IconFolderOpen aria-hidden size={16} />}
          title="Author it as a folder"
          visual={<AgentFolder />}
        >
          An instructions.md file is a complete agent. Add skills, tools, and channels as files, and
          eve picks them up by name.
        </FeatureCard>
        <FeatureCard
          href="/docs/guides/dynamic-capabilities"
          icon={<IconSparkles aria-hidden size={16} />}
          title="Build it dynamically"
          visual={<DynamicTool />}
        >
          Return tools, skills, models, or instructions from code that runs each session, shaped by
          the caller, the channel, or your data.
        </FeatureCard>
      </ul>
    </HomeSection>
  );
}
