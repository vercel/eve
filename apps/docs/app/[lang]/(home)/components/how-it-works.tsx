import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      id="how-it-works"
      lede="Write your agent as plain files. When it needs to behave differently for each customer, make any file dynamic."
      title="Dynamic where you need it"
    >
      <FileTree />
    </HomeSection>
  );
}
