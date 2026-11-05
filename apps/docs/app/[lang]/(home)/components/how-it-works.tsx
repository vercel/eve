import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="Create an agent from a folder of files: an instructions.md file is all you need. Define any file dynamically, and each customer gets their own version of the same agent."
      title="How it works"
    >
      <FileTree />
    </HomeSection>
  );
}
