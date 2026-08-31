import { GeistdocsHomeLayout } from "@vercel/geistdocs/home-layout";
import { config } from "@/lib/geistdocs/config";
import { getRootLang } from "@/lib/geistdocs/root-params";
import { source } from "@/lib/geistdocs/source";
import { ScrollState } from "./components/scroll-state";

const Layout = async ({ children }: LayoutProps<"/[lang]">) => {
  const lang = await getRootLang();

  return (
    <GeistdocsHomeLayout config={config} tree={source.pageTree[lang]}>
      <div data-home-route hidden />
      <ScrollState />
      <div className="bg-background-200 pt-0 pb-32">{children}</div>
    </GeistdocsHomeLayout>
  );
};

export default Layout;
