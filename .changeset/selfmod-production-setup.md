---
"eve": patch
"@eve/self-modification": patch
---

Add guided setup for deployed source changes. It distinguishes Git-connected Vercel from manually configured CI or self-hosted builds, reports each deployment prerequisite without storing credentials in source, and keeps the deployed subagent hidden until source metadata and a GitHub credential are available.
