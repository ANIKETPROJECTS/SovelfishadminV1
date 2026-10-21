---
name: OpenAPI code generation and Zod 3
description: Compatibility notes for regenerating API clients and schemas in this Node 20 workspace.
---

Orval's generated Zod output may use `zod.int()`, which is not available in the project's Zod 3 runtime. Replace those generated calls with `zod.number().int()` and rebuild/start the API to catch runtime-only schema errors. This workspace's Node 20 also lacks `Map.groupBy`, which Orval currently expects during generation; use a temporary, non-committed polyfill when needed.

**Why:** API builds can succeed even when generated schemas fail during module initialization, and the code generator may fail before writing files on the installed Node version.

**How to apply:** After changing the OpenAPI spec or regenerating clients, inspect generated Zod APIs for Zod 4-only methods, then start the API—not just compile it—before considering generation verified.
