import { createChangelogPage } from "@vercel/geistdocs/pages/changelog";
import { changelogOptions } from "@/lib/geistdocs/changelog";
import { getRootLang } from "@/lib/geistdocs/root-params";

const changelogPage = createChangelogPage({
  ...changelogOptions,
  getLang: getRootLang,
});

export const generateMetadata = changelogPage.generatePaginatedMetadata;
export const generateStaticParams = changelogPage.generatePageParams;
export default changelogPage.PaginatedPage;
