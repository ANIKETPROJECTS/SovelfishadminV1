---
name: Sub-hub Mongo debugging
description: A caution about inspecting FishTokri sub-hub product data outside the running API workflow.
---

Direct Mongo shell probes using the workspace URI can resolve to the default database and show no `sub_hubs`, even while the API workflow is serving valid scoped sub-hub data.

**Why:** The API selects a database per sub-hub and may use a workflow-specific runtime connection context; an apparently empty direct probe can be misleading.

**How to apply:** Prefer the API’s authenticated response and workflow logs when debugging sub-hub products. Do not mutate product data based only on an empty direct shell probe.

### Safe inventory test writes

Run end-to-end inventory deduction tests in an inactive temporary sub-hub with its own unique database; do not alter batches in an active sellable sub-hub.

**Why:** The shared MongoDB connection may point at production, and temporary stock changes can affect order availability.

**How to apply:** Use the API’s database helpers to create a temporary sub-hub and tagged test orders, then remove the orders, drop the temporary database, and delete the sub-hub in cleanup.

### Sub-hub database renames

Treat a `dbName` change as a data migration, not a database rename: copy collections, documents, and indexes to the new database, verify them, then switch the hub metadata. Keep the old database as a backup unless the user separately requests its deletion.

**Why:** `dbName` selects the database path used by the API connection helper; changing only the field can send the app to an empty database and hide existing inventory.

**How to apply:** Pause writes where possible, use the API-scoped connection helper, verify collection counts and indexes before switching, update hub-name snapshots, and restart the API after cutover.