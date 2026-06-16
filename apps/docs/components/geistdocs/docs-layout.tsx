import { GeistdocsDocsLayout as PackageDocsLayout } from "@vercel/geistdocs/layout";
import type { ComponentProps, ReactNode } from "react";
import { config } from "@/lib/geistdocs/config";

interface DocsLayoutProps {
  children: ReactNode;
  tree: ComponentProps<typeof PackageDocsLayout>["tree"];
}

export const DocsLayout = ({ tree, children }: DocsLayoutProps) => (
  <PackageDocsLayout
    config={config}
    containerProps={{
      className: "bg-background-100 max-w-[1448px] mx-auto",
    }}
    tree={tree}
  >
    {children}
  </PackageDocsLayout>
);
