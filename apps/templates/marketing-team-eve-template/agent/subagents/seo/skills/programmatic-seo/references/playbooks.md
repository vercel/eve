# The twelve playbooks

Each entry gives the query shape, the data it needs, and how it usually fails. The failure line matters more than the pattern: every one of these works when the data is real and fails the same way when it isn't.

## 1. Templates

Query: "[type] template", "[type] template free".
Data: the templates themselves, plus a preview image and the fields describing each.
Page: a preview, what it's for, how to use it, and the download or copy action above the fold.
Fails when: the template is a thin table nobody would use, or the page makes you sign up to see anything. Search intent here is transactional, so a gate before the preview loses both the ranking and the visitor.

## 2. Curation

Query: "best [category]", "top [category] for [use case]".
Data: a scored comparison across real options, ideally with your own testing behind it.
Page: the criteria, the picks with reasons, and where each one is the wrong choice.
Fails when: it lists every option with no opinion, or ranks by affiliate payout. Naming who should not pick your top choice is what makes the rest credible.

## 3. Conversions

Query: "[X] to [Y]", "[N] [unit] in [unit]".
Data: a conversion rate or formula, ideally live.
Page: the answer at the top, then the formula, then common values nearby.
Fails when: the answer is below the fold, or the rate is stale. These queries have enormous volume and near-zero patience.

## 4. Comparisons

Query: "[X] vs [Y]", "[competitor] alternative".
Data: verified feature, pricing, and limit data for both sides, with a date.
Page: an honest table, where each option wins, and who should pick the other one.
Fails when: the competitor's column is out of date or unfair. A comparison that only your product could win reads that way, and it dates badly the moment the competitor ships.

## 5. Examples

Query: "[type] examples", "[type] examples that work".
Data: real examples with images and a note on why each is included.
Page: the example, what it does well, and what to copy from it.
Fails when: it's a gallery with no analysis. The screenshots are the draw; the reason each one is there is the value.

## 6. Locations

Query: "[service] in [city]", "[service] near me".
Data: something genuinely local per page: real listings, local pricing, local regulation, coverage.
Page: local specifics first, then the general information.
Fails when: the city name is the only difference. This is the canonical thin-content case and the one Google's doorway-page policy describes most directly. If you cannot say something true about that city, don't make the page.

## 7. Personas

Query: "[product category] for [audience]".
Data: how the product is actually used by that segment, with real examples.
Page: that segment's problem, the workflow that solves it, proof from someone like them.
Fails when: it's the homepage with the audience noun swapped. If the screenshots and the objections don't change per persona, the segments aren't distinct enough for separate pages.

## 8. Integrations

Query: "[product A] [product B] integration", "connect [A] to [B]".
Data: your integration catalog plus what each integration actually does.
Page: what the connection enables, setup steps, what syncs and what doesn't.
Fails when: it lists integrations you don't have, or every page says "seamlessly connect" with no mechanics. What syncs, in which direction, how often, is the whole reason someone searched.

## 9. Glossary

Query: "what is [term]", "[term] meaning".
Data: subject expertise and a consistent structure.
Page: a direct one-paragraph definition, then why it matters, an example, and related terms.
Fails when: definitions are paraphrased from other glossaries. Answer in the first paragraph and add the thing only a practitioner would know.

## 10. Translations

Query: existing winning queries, in another language.
Data: real translation, not just the interface strings.
Page: the source page's value, fully localized.
Fails when: only the chrome is translated, or hreflang and canonical are wrong. Read `../../seo-audit/references/international-seo.md` before starting: the technical failure modes here void whole locale clusters silently.

## 11. Directory

Query: "[category] tools", "[category] companies".
Data: a maintained listing set with enough fields to filter and sort.
Page: the filtered list plus what's true of this slice specifically.
Fails when: listings go stale or every filter combination becomes a page. Index the combinations with demand; leave the rest to filtering that doesn't generate URLs.

## 12. Profiles

Query: "[entity name]", "[entity] [attribute]".
Data: a reliable entity data set you can keep current.
Page: the facts, sourced, with the update date visible.
Fails when: facts are wrong or unattributed. Profile pages about real people and companies carry accuracy obligations well beyond SEO, so cite the source and date every claim.

## Layering

Combining two patterns usually beats extending one, because the combined query is more specific and less contested. Curation plus Locations gives "best [category] in [city]". Personas plus Integrations gives "[product] for [audience] with [tool]". The constraint is data: each added dimension multiplies the pages and divides the evidence you have per page, so layer only while each cell still has something real in it.

## Sources

- Google Search Central, Spam policies (doorway pages, scaled content abuse): https://developers.google.com/search/docs/essentials/spam-policies
- Google Search Central, Creating helpful, reliable, people-first content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
