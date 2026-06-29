import { GeistdocsHomeLayout } from "@vercel/geistdocs/home-layout";
import { config } from "@/lib/geistdocs/config";
import { source } from "@/lib/geistdocs/source";
import { ScrollState } from "./components/scroll-state";

const Layout = async ({ children, params }: LayoutProps<"/[lang]">) => {
  const { lang } = await params;

  return (
    <GeistdocsHomeLayout config={config} tree={source.pageTree[lang]}>
      {/* TODO: check logic here */}
      {/* Marker so the global footer can be tinted on home routes only,
          via the `body:has([data-home-route]) footer` rule in geistdocs.css. */}
      <div data-home-route hidden />
      <ScrollState />
      <div className="bg-background-200 pt-0 pb-32">{children}</div>
    </GeistdocsHomeLayout>
  );
};

export default Layout;
