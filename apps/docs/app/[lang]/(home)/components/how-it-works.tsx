import { IconFolderOpen } from "@vercel/geistdocs/assets/icons";
import { Button } from "@vercel/geistdocs/components/button";
import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection, PrefetchLink } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      action={
        <Button
          className="w-fit rounded-full text-base"
          Component={PrefetchLink}
          href="/templates/eve-coding-agent-template"
          size="large"
        >
          Explore the coding agent template
        </Button>
      }
      id="how-it-works"
      lede="An instructions.md file is all you need to run an agent. Skills, tools, channels, and the rest are optional building blocks you add as it grows."
      title={
        <>
          Your{" "}
          <span className="relative -top-[0.08em] ml-1 inline-flex items-center gap-[0.24em] rounded-lg bg-gray-200 px-3 py-[0.04em] pr-4 align-baseline font-[450]!">
            <IconFolderOpen
              aria-hidden
              className="size-[0.58em] translate-y-[0.06em] text-gray-900"
            />
            agent/
          </span>{" "}
          is a folder
        </>
      }
    >
      <FileTree />
    </HomeSection>
  );
}
