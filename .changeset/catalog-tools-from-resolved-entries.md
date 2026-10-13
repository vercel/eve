---
"eve": patch
---

A dynamic resolver no longer adds `eve__search` and `eve__tool` on its own. eve adds the catalog tools once a session reaches something they find, call, or load, such as a deferred entry a resolver returns, and keeps them for the rest of the session. Agents whose resolvers return only listed tools no longer see these tools or spend steps searching.
