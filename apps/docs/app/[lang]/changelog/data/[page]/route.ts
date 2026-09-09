import { createChangelogDataRoute } from "@vercel/geistdocs/routes/changelog";
import { changelogOptions } from "@/lib/geistdocs/changelog";

const changelogRoute = createChangelogDataRoute(changelogOptions);

export const GET = changelogRoute.GET;
export const generateStaticParams = changelogRoute.generateStaticParams;
