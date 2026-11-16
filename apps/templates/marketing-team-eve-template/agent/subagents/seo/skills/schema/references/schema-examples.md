# Schema examples

Valid JSON-LD for the types that come up most. Replace every value with the page's real content. Each block goes in a `<script type="application/ld+json">` tag.

## Organization

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://example.com/#organization",
  "name": "Example",
  "url": "https://example.com",
  "logo": "https://example.com/logo.png",
  "description": "One sentence on what the company does.",
  "sameAs": [
    "https://x.com/example",
    "https://www.linkedin.com/company/example"
  ],
  "contactPoint": {
    "@type": "ContactPoint",
    "contactType": "customer support",
    "email": "support@example.com"
  }
}
```

## WebSite with site search

The `SearchAction` only matters if the site has a working search results page at that URL pattern.

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": "https://example.com/#website",
  "name": "Example",
  "url": "https://example.com",
  "potentialAction": {
    "@type": "SearchAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "https://example.com/search?q={search_term_string}"
    },
    "query-input": "required name=search_term_string"
  }
}
```

## Article or BlogPosting

```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "The post title, under 110 characters",
  "description": "The meta description or a one-sentence summary.",
  "image": ["https://example.com/images/post-16x9.jpg"],
  "datePublished": "2026-07-25T09:00:00-07:00",
  "dateModified": "2026-07-25T09:00:00-07:00",
  "author": {
    "@type": "Person",
    "name": "Author Name",
    "url": "https://example.com/authors/author-name"
  },
  "publisher": {
    "@type": "Organization",
    "name": "Example",
    "logo": {
      "@type": "ImageObject",
      "url": "https://example.com/logo.png"
    }
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://example.com/blog/post-slug"
  }
}
```

`author` as a real `Person` with a URL to a real author page carries more weight than a bare string, and it's what makes the experience and expertise signals legible.

## Product

`offers` is required. Omit `aggregateRating` and `review` unless real ratings exist on the page.

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Product Name",
  "image": ["https://example.com/images/product.jpg"],
  "description": "What the product is.",
  "sku": "SKU-123",
  "brand": { "@type": "Brand", "name": "Example" },
  "offers": {
    "@type": "Offer",
    "url": "https://example.com/products/product-name",
    "priceCurrency": "USD",
    "price": "49.00",
    "availability": "https://schema.org/InStock",
    "priceValidUntil": "2027-01-01"
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "4.6",
    "reviewCount": "127"
  }
}
```

## SoftwareApplication

For a SaaS or app page. A free tier is `price: "0"`, not an omitted `offers`.

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Product Name",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "description": "What the product does.",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  }
}
```

## FAQPage

Only for questions and answers actually visible on the page. An FAQPage describing hidden or invented questions is the classic penalized case.

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How long does setup take?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Most teams finish in under ten minutes."
      }
    },
    {
      "@type": "Question",
      "name": "Is there a free plan?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, with up to three projects."
      }
    }
  ]
}
```

## HowTo

```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to do the thing",
  "totalTime": "PT15M",
  "step": [
    {
      "@type": "HowToStep",
      "name": "First step",
      "text": "What to do.",
      "url": "https://example.com/guide#step-1"
    },
    {
      "@type": "HowToStep",
      "name": "Second step",
      "text": "What to do next.",
      "url": "https://example.com/guide#step-2"
    }
  ]
}
```

## BreadcrumbList

`position` starts at 1. The current page is the last item and conventionally omits `item`.

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://example.com"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Features",
      "item": "https://example.com/features"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "Analytics"
    }
  ]
}
```

## LocalBusiness

Name, address, and phone must match what the page shows and what other listings say.

```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "Example Studio",
  "image": "https://example.com/images/storefront.jpg",
  "url": "https://example.com/locations/austin",
  "telephone": "+1-512-555-0100",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "100 Congress Ave",
    "addressLocality": "Austin",
    "addressRegion": "TX",
    "postalCode": "78701",
    "addressCountry": "US"
  },
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      "opens": "09:00",
      "closes": "17:00"
    }
  ]
}
```

## Event

```json
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Event Name",
  "startDate": "2026-09-15T10:00:00-07:00",
  "endDate": "2026-09-15T11:00:00-07:00",
  "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
  "eventStatus": "https://schema.org/EventScheduled",
  "location": {
    "@type": "VirtualLocation",
    "url": "https://example.com/webinars/event-name"
  },
  "organizer": {
    "@type": "Organization",
    "name": "Example",
    "url": "https://example.com"
  }
}
```

## Several types on one page

Use one `@graph` and let entities reference each other by `@id` rather than repeating the organization on every entity.

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://example.com/#organization",
      "name": "Example",
      "url": "https://example.com"
    },
    {
      "@type": "WebSite",
      "@id": "https://example.com/#website",
      "url": "https://example.com",
      "publisher": { "@id": "https://example.com/#organization" }
    },
    {
      "@type": "BlogPosting",
      "headline": "The post title",
      "datePublished": "2026-07-25T09:00:00-07:00",
      "image": ["https://example.com/images/post.jpg"],
      "author": { "@type": "Person", "name": "Author Name" },
      "publisher": { "@id": "https://example.com/#organization" },
      "isPartOf": { "@id": "https://example.com/#website" }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://example.com"
        },
        { "@type": "ListItem", "position": 2, "name": "Blog" }
      ]
    }
  ]
}
```

## Next.js

Render it server side so it's in the HTML a crawler receives. In the App Router, a script tag in the page or layout is enough.

```tsx
export default function Page() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    datePublished: post.publishedAt,
    author: { "@type": "Person", name: post.author.name },
  };

  return (
    <>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD has no safe typed alternative
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        type="application/ld+json"
      />
      <article>{/* ... */}</article>
    </>
  );
}
```

Build the object from the same data that renders the page, so the two can't drift apart. Hard-coding schema values separately from the visible content is how markup ends up describing a page that has since changed.
