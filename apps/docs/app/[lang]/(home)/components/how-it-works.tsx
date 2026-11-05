import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="Create an agent from a folder of files: an instructions.md file is all you need. Make it multi-tenant by defining any part of it dynamically, per caller."
      title="How it works"
    >
      <FileTree />
    </HomeSection>
  );
}
