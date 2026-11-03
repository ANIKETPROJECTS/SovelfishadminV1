---
name: Product weight variants
description: Data and inventory rules for products sold in multiple weights or package sizes.
---

Represent each sellable weight or package size as its own product record, linked to its sibling variants. Each record owns its price and batch inventory; net weight supplies the displayed variant label. Unit is shared by the group and inherited from the base product. Keep the original product record as the first variant so its ID, stock, and order history remain intact. Variants may be archived or permanently deleted, but never allow deletion of the final remaining variant; deleting a variant also deletes its embedded batches. Coerce weight fields to strings at UI boundaries because existing records may store them as numbers.

**Why:** POS order items and inventory deduction/restoration are keyed by product ID. Separate records isolate prices and batches without migrating existing order history, and every product must retain at least one sellable-size record. Legacy numeric weight values otherwise break string operations such as trimming.

**How to apply:** Resolve sales and stock changes to the selected variant's product ID. Use net weight for POS and inventory labels; do not add a per-variant unit or manual label control. Convert loaded weight values to strings before editing or validating them. Keep archived variants out of new POS sales, but preserve their records for history and restoration. Permit permanent deletion only while another variant remains.

For whole fish sold individually, staff enter each day's fish weight and a fixed total price for that fish, not a per-kilogram rate, from inventory. Each fish is sold whole, and the same weight/price availability must appear in POS and on the storefront.

**Why:** Whole fish arrive in variable sizes and prices each day, so fixed reusable weight variants do not fit this stock workflow.

**How to apply:** Keep daily whole-fish stock entries distinct from standard reusable weight variants, and ensure a sale removes the exact fish entry. Confirm whether price is a per-fish total or a per-kilogram rate before implementing its calculation.
