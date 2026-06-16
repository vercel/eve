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
    <aside className="mx-auto w-full max-w-[900px] px-4 pt-6 md:px-6 md:pt-8 xl:px-8 xl:pt-10 [grid-column:main]">
      <div className="border-amber-600 border-l pl-4 text-gray-900 text-sm leading-6">
        <span className="font-medium text-gray-1000">Beta.</span> Eve is currently in beta and
        subject to the{" "}
        <a
          className="font-medium text-gray-1000 underline decoration-gray-600/40 underline-offset-4 transition-colors hover:decoration-gray-1000"
          href="https://vercel.com/docs/release-phases/public-beta-agreement"
        >
          Vercel beta terms
        </a>
        ; the framework, APIs, documentation, and behavior may change before general availability.
      </div>
    </aside>
    {children}
  </PackageDocsLayout>
);
