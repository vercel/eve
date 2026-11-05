import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="Create an agent from a folder of files: an instructions.md file is all you need. Define any file dynamically, and the same agent adapts to each customer it serves."
      title="How it works"
    >
      <FileTree />
    </HomeSection>
  );
}
