import { IconChevronRightSmall, IconFolderOpen } from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX } from "react";
import { FileTree } from "./file-tree";

export function HowItWorks(): JSX.Element {
  return (
    <section aria-labelledby="how-it-works-title" className="py-16 sm:py-24" id="how-it-works">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-center">
        <h2
          className="text-balance text-heading-32 text-gray-1000 sm:text-heading-40"
          id="how-it-works-title"
        >
          Your{" "}
          <span className="relative -top-[0.08em] ml-1 inline-flex items-center gap-[0.24em] rounded-lg bg-gray-200 px-3 py-[0.04em] pr-4 align-baseline font-[450]!">
            <IconFolderOpen
              aria-hidden
              className="size-[0.58em] translate-y-[0.06em] text-gray-900"
            />
            agent/
          </span>{" "}
          is a folder
        </h2>
        <p className="max-w-2xl text-balance text-gray-900">
          An instructions.md file is all you need to run an agent. Skills, tools, channels, and the
          rest are optional building blocks you add as it grows.
        </p>
        <Link
          className="group inline-flex items-center text-copy-14 text-gray-1000"
          href="/templates/eve-coding-agent-template"
          prefetch={true}
        >
          Explore the coding agent template
          <IconChevronRightSmall
            className="text-gray-900 transition-transform group-hover:translate-x-0.5"
            size={16}
          />
        </Link>
      </div>
      <div className="mx-auto mt-12 max-w-5xl">
        <FileTree />
      </div>
    </section>
  );
}
