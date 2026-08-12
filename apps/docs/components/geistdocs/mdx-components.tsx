import { createMdxComponents } from "@vercel/geistdocs/mdx";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { AgentRuntimeDiagram } from "./agent-runtime-diagram";
import {
  AuthoringShape,
  ComparisonHero,
  ComparisonMatrix,
  FrameworkFit,
  MultiplayerTimeline,
} from "./framework-comparison";

const localComponents: MDXComponents = {
  a: ({ href, ...props }) =>
    typeof href === "string" && href.startsWith("/") ? (
      <Link className="font-normal text-primary no-underline" href={href} {...props} />
    ) : (
      <a href={href} {...props} className="font-normal text-primary no-underline" />
    ),
  File,
  Files,
  Folder,
  AgentRuntimeDiagram,
  AuthoringShape,
  ComparisonHero,
  ComparisonMatrix,
  Step,
  Steps,
  FrameworkFit,
  MultiplayerTimeline,
};

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  createMdxComponents({
    ...localComponents,
    // User components last to allow overwriting defaults.
    ...components,
  });
