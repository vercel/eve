import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="An instructions.md file is all you need to run an agent. Add skills, tools, channels, and the rest as files, or build any of them in code for each session."
      title="How it works"
    >
      <FileTree />
    </HomeSection>
  );
}
