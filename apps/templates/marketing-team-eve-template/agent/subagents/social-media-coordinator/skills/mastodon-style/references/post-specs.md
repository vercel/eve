# Mastodon post specs

Quick lookup for hard constraints. All facts from Mastodon's own docs unless noted.

## Limits

| Spec | Value |
| --- | --- |
| Character limit | 500 by default; some instances allow more. Write for 500. |
| Link length | Any URL counts as a flat **23 characters**, regardless of actual length. |
| Link shorteners | Discouraged: links are already counted as 23, so shorteners add nothing. |
| Mentions | Only the `@username` part counts toward the limit; the `@domain` does not. |
| Editing | Posts can be edited after publishing. |

## Alt text

- Add a description to every image attachment. Used by screen readers and assistive tech, and shown when media fails to load.

## Content warnings (CW)

- A short label that collapses the post body; readers see only the label until they click.
- Used for sensitive topics, spoilers, long posts, or as a subject-line style summary.
- Adding a CW also marks attached media as sensitive (blurred until revealed).

## Hashtags

- Make posts discoverable: by default, public posts appear in search only via hashtags (full-text search is opt-in), so untagged posts are largely invisible to topic searches.
- Allowed characters: alphanumeric and underscores. Cannot be numbers only.
- Use CamelCase for multi-word tags (`#WebDev`) so screen readers parse the words.
- Placement is free: a tag works anywhere in the post.

## Sources

- Mastodon docs - Posting to your profile: https://docs.joinmastodon.org/user/posting/
- Buffer - A Beginner's Guide to Mastodon: https://buffer.com/resources/mastodon-social/
- Fedi.Tips - What are hashtags? How do I use them on Mastodon and the Fediverse?: https://fedi.tips/what-are-hashtags-how-do-i-use-them-on-mastodon-and-the-fediverse/
