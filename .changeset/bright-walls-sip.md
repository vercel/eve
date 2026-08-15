---
"eve": patch
---

Prevent interactive setup from hanging after Vercel successfully pulls project environment variables. Environment pulls now run without terminal input and time out safely if the Vercel CLI does not exit.
