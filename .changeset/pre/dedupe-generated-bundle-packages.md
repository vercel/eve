---
"eve": patch
---

Deployed agents start faster and use less memory, because hosted builds now include each installed package once instead of once per instrumentation file and once more for the agent's modules.

Before, when instrumentation files imported the same packages as the agent, every one of those packages shipped, loaded, and ran more than once on each cold start. In one production agent with five instrumentation files, the workflow route's bundle dropped from 34 MB to 22 MB and its cold start from about 2.6 s to about 1.8 s.
