---
name: Product weight variants
description: Data and inventory rules for products sold in multiple weights or package sizes.
---

Represent each sellable weight or package size as its own product record, linked to its sibling variants. Each record owns its price and batch inventory. Keep the original product record as the first variant so its ID, stock, and order history remain intact. Archive variants instead of hard-deleting them.

**Why:** POS order items and inventory deduction/restoration are keyed by product ID. Separate records isolate prices and batches without migrating existing order history.

**How to apply:** Resolve sales and stock changes to the selected variant's product ID. Display its variant label in POS and inventory views. Keep archived variants out of new POS sales, but preserve their records for history and restoration.
