export function useSite() {
  const appConfig = useAppConfig();
  const runtimeConfig = useRuntimeConfig();
  const requestUrl = useRequestURL();

  const site = appConfig.site;
  const origin = runtimeConfig.public.siteUrl || requestUrl.origin;

  return {
    ...site,
    origin,
    url: (path = "/") => new URL(path, origin).href,
  };
}

export function useSiteSeo(options?: { title?: string; description?: string; path?: string }) {
  const site = useSite();
  const route = useRoute();

  const title = options?.title ?? site.title;
  const description = options?.description ?? site.description;
  const path = options?.path ?? route.path;
  const canonical = site.url(path);
  const ogImage = site.url(site.ogImage);

  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogType: "website",
    ogUrl: canonical,
    ogSiteName: site.name,
    ogImage,
    twitterCard: "summary_large_image",
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: ogImage,
    twitterSite: site.twitter,
  });

  useHead({
    link: [{ rel: "canonical", href: canonical }],
    meta: [
      { name: "author", content: site.author },
      {
        name: "keywords",
        content:
          "Eve, Nuxt, personal agent, AI assistant, Better Auth, Slack, iMessage, Linear, template",
      },
    ],
    script: [
      {
        type: "application/ld+json",
        innerHTML: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: site.name,
          description: site.description,
          url: site.origin,
          image: ogImage,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Any",
          offers: {
            "@type": "Offer",
            price: "0",
            priceCurrency: "USD",
          },
          isPartOf: {
            "@type": "SoftwareSourceCode",
            codeRepository: site.repo,
            programmingLanguage: "TypeScript",
          },
        }),
      },
    ],
  });

  return { title, description, canonical };
}
