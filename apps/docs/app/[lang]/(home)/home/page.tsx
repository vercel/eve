import { HomeContent, homeMetadata } from "../components/home-content";

// Temporary alias of the landing page so the preview is reachable while `/`
// is being forwarded at the domain level.
export const metadata = homeMetadata;

const HomeAliasPage = () => <HomeContent />;

export default HomeAliasPage;
