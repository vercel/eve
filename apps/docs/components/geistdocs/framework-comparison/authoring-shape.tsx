import { Braces, FileCode2, FileText, Folder, FolderOpen, Sparkles } from "lucide-react";
import type { JSX, ReactNode } from "react";

function TreeRow({
  depth = 0,
  icon,
  children,
  note,
}: {
  depth?: number;
  icon: ReactNode;
  children: ReactNode;
  note?: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 py-1.5" style={{ paddingLeft: depth * 16 }}>
      <span className="shrink-0 text-gray-900">{icon}</span>
      <code className="min-w-0 truncate bg-transparent! p-0! text-copy-13! text-gray-1000!">
        {children}
      </code>
      {note ? (
        <span className="ml-auto hidden text-copy-13 text-gray-700 sm:block">{note}</span>
      ) : null}
    </div>
  );
}

function Panel({
  eyebrow,
  title,
  children,
  featured = false,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  featured?: boolean;
}): JSX.Element {
  return (
    <section
      className={
        featured
          ? "min-w-0 rounded-xl border border-blue-500 bg-blue-100 p-4 shadow-sm sm:p-5"
          : "min-w-0 rounded-xl border border-gray-alpha-400 bg-background-100 p-4 sm:p-5"
      }
    >
      <div className="font-mono uppercase tracking-[0.1em] text-label-13 text-gray-900">
        {eyebrow}
      </div>
      <h3 className="mt-1 font-medium text-copy-16 text-gray-1000">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Contrasts capability-oriented filesystem authoring with centralized composition code. */
export function AuthoringShape(): JSX.Element {
  return (
    <figure className="not-prose my-8 grid min-w-0 gap-4 lg:grid-cols-2">
      <Panel eyebrow="eve" title="The directory is the agent" featured>
        <div className="rounded-lg border border-blue-500/30 bg-background-100 px-3 py-2 shadow-xs">
          <TreeRow icon={<FolderOpen aria-hidden size={15} />}>agent/</TreeRow>
          <TreeRow depth={1} icon={<FileCode2 aria-hidden size={15} />} note="model + limits">
            agent.ts
          </TreeRow>
          <TreeRow depth={1} icon={<FileText aria-hidden size={15} />} note="identity">
            instructions.md
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="actions">
            tools/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="procedures">
            skills/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="services">
            connections/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="people + events">
            channels/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="specialists">
            subagents/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="workspace">
            sandbox/
          </TreeRow>
          <TreeRow depth={1} icon={<Folder aria-hidden size={15} />} note="autonomy">
            schedules/
          </TreeRow>
        </div>
        <div className="mt-4 flex items-start gap-2 text-copy-14 text-gray-900">
          <Sparkles aria-hidden className="mt-0.5 shrink-0 text-blue-900" size={15} />
          Add a capability by adding a file. Its path supplies its role and name.
        </div>
      </Panel>

      <Panel eyebrow="Common alternative" title="The composition module is the agent">
        <div className="rounded-lg border border-gray-alpha-400 bg-background-200 px-4 py-3 font-mono text-copy-13 text-gray-1000 shadow-inner">
          <div className="flex items-center gap-2 text-gray-900">
            <Braces aria-hidden size={14} /> agent.ts
          </div>
          <pre className="mt-3 overflow-hidden bg-transparent! p-0! text-copy-13! leading-6! text-gray-1000!">
            <code>{`new Agent({
  instructions,
  tools: [search, write, ...],
  memory: new Memory(...),
  workspace: new Workspace(...),
  subagents: [researcher, ...],
  // every concern converges here
})`}</code>
          </pre>
        </div>
        <p className="mt-4 text-copy-14 text-gray-900">
          This is concise at five capabilities. At fifty, the agent becomes an import graph whose
          architecture is no longer visible from the filesystem.
        </p>
        <div className="mt-4 rounded-lg border border-gray-alpha-400 bg-background-200 p-3 text-copy-13 text-gray-900">
          Some competitors now add file discovery, but usually as a partial layer over this
          code-first center.
        </div>
      </Panel>

      <figcaption className="sr-only">
        eve represents an agent as a recursive directory of capabilities, while common agent SDKs
        centralize composition in a TypeScript or Python configuration module.
      </figcaption>
    </figure>
  );
}
