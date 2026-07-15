---
"eve": patch
---

Fix `eve dev` generation bundling for authored modules whose dependencies use dynamic imports. Development generations now bundle ordinary dependencies directly instead of inheriting a copied server-external package list and tracing dependency closures; Nitro remains the sole owner of hosted dependency packaging.
