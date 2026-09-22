import { createChangelogMarkdownRoute } from "@vercel/geistdocs/routes/changelog";
import { changelogOptions } from "@/lib/geistdocs/changelog";

const changelogRoute = createChangelogMarkdownRoute(changelogOptions);

export const GET = changelogRoute.GET;
export const generateStaticParams = changelogRoute.generateStaticParams;
