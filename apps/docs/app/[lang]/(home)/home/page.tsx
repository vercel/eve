import { HomeContent, homeMetadata } from "../components/home-content";

// TODO: remove /home alias once rewrite in Vercel dashboard is taken out

// Temporary alias of the landing page so the preview is reachable while `/`
// is being forwarded at the domain level.
export const metadata = homeMetadata;

const HomeAliasPage = () => <HomeContent />;

export default HomeAliasPage;
