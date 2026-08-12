import { ArrowDown, FolderTree, ShieldCheck, Users } from "lucide-react";
import type { JSX, ReactNode } from "react";

function Pill({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <span className="flex items-center gap-2 rounded-full border border-gray-alpha-400 bg-background-100 px-3 py-1.5 text-copy-13 text-gray-1000 shadow-xs">
      {icon}
      {children}
    </span>
  );
}

/** Introduces the comparison's thesis and the three cross-cutting eve advantages. */
export function ComparisonHero(): JSX.Element {
  return (
    <section className="not-prose relative my-8 overflow-hidden rounded-2xl border border-gray-alpha-400 bg-background-100 px-5 py-8 sm:px-8 sm:py-10">
      <div
        aria-hidden
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(circle at 12% 12%, var(--ds-blue-300) 0, transparent 30%), radial-gradient(circle at 88% 86%, var(--ds-purple-300) 0, transparent 28%)",
        }}
      />
      <div className="relative">
        <div className="mb-5 flex items-center gap-2 font-mono uppercase tracking-[0.12em] text-blue-900 text-label-13">
          <span className="size-1.5 rounded-full bg-blue-700" />
          Framework comparison · July 2026
        </div>
        <p className="max-w-3xl font-medium text-heading-24 tracking-tight text-gray-1000 sm:text-heading-32">
          Give the model a harness,
          <br className="hidden sm:block" /> not a maze.
        </p>
        <p className="mt-4 max-w-2xl text-balance text-copy-16 text-gray-900">
          Models will keep getting smarter. The winning framework is the one that lets that
          intelligence compound without turning every new capability into more orchestration code.
        </p>
        <div className="mt-7 flex flex-wrap gap-2">
          <Pill icon={<FolderTree aria-hidden size={15} />}>Filesystem-first</Pill>
          <Pill icon={<ShieldCheck aria-hidden size={15} />}>Durable by default</Pill>
          <Pill icon={<Users aria-hidden size={15} />}>Identity-aware multiplayer</Pill>
        </div>
        <div className="mt-8 flex items-center gap-2 text-copy-13 text-gray-900">
          <ArrowDown aria-hidden size={14} />
          Compare the architecture, not the demo
        </div>
      </div>
    </section>
  );
}
