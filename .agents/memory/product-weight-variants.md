---
name: Product weight variants
description: Data and inventory rules for products sold in multiple weights or package sizes.
---

Represent each sellable weight or package size as its own product record, linked to its sibling variants. Each record owns its price and batch inventory; net weight supplies the displayed variant label. Unit is shared by the group and inherited from the base product. Keep the original product record as the first variant so its ID, stock, and order history remain intact. Archive variants instead of hard-deleting them.

**Why:** POS order items and inventory deduction/restoration are keyed by product ID. Separate records isolate prices and batches without migrating existing order history.

**How to apply:** Resolve sales and stock changes to the selected variant's product ID. Use net weight for POS and inventory labels; do not add a per-variant unit or manual label control. Keep archived variants out of new POS sales, but preserve their records for history and restoration.
