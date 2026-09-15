---
"eve": patch
---

Bound negotiated session stream responses with renewable leases so abandoned serverless invocations release their durable stream readers. The eve client renews these responses from its cursor without exposing transport heartbeats or lease records as session events; tail-relative reads and streams with reconnection disabled remain unleased.
