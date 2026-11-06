---
"eve": patch
---

The Slack sign-in prompt now shows how the sign-in ended after the person clicks Connect.

Slack only lets an app change an ephemeral message through the `response_url` of a click on it, so the Connect button now has an `action_id`, and its click follows the session until that sign-in settles, then replaces the prompt with the outcome, such as ":white_check_mark: Linear connected". A sign-in finished through a copied link, or later than the interactivity function or Slack's 30-minute `response_url` allows, leaves the prompt as before.
