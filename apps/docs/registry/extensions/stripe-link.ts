import link from "@stripe/link-integrations-eve";

export default link({
  accessToken: process.env.LINK_ACCESS_TOKEN!,
});
