import { Button } from "@vercel/geistdocs/components/button";
import type { JSX } from "react";
import { FileTree } from "./file-tree";
import { HomeSection } from "./section";

export function HowItWorks(): JSX.Element {
  return (
    <HomeSection
      action={
        <Button
          className="w-fit rounded-full text-base"
          href="/docs/guides/dynamic-capabilities"
          size="large"
        >
          Read the docs
        </Button>
      }
      id="how-it-works"
      lede="Write your agent as plain files. When it needs to behave differently for each customer, make any file dynamic."
      title="Dynamic where you need it"
    >
      <FileTree />
    </HomeSection>
  );
}
