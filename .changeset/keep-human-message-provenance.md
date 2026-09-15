---
"eve": patch
---

Treat only model-history entries explicitly classified as human input as retained user prompts during compaction. Repaired legacy histories now carry a model-message format version, so current snapshots skip repeated compatibility scans.
