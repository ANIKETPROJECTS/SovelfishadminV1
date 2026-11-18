---
name: Banner video directory scope
description: User requirement for per-sub-hub VPS storage of banner video files.
---

Banner video directories are configured separately for each sub-hub; a single shared VPS folder is not sufficient.

**Why:** the user requested different video locations across multiple sub-hubs.

**How to apply:** keep each sub-hub's folder setting and file operations scoped to that sub-hub.
