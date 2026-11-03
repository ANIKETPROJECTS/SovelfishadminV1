---
name: Product weight variants
description: Data and inventory rules for products sold in multiple weights or package sizes.
---

Represent each sellable weight or package size as its own product record, linked to its sibling variants. Each record owns its price and batch inventory; net weight supplies the displayed variant label. Unit is shared by the group and inherited from the base product. Keep the original product record as the first variant so its ID, stock, and order history remain intact. Variants may be archived or permanently deleted, but never allow deletion of the final remaining variant; deleting a variant also deletes its embedded batches. Coerce weight fields to strings at UI boundaries because existing records may store them as numbers.

**Why:** POS order items and inventory deduction/restoration are keyed by product ID. Separate records isolate prices and batches without migrating existing order history, and every product must retain at least one sellable-size record. Legacy numeric weight values otherwise break string operations such as trimming.

**How to apply:** Resolve sales and stock changes to the selected variant's product ID. Use net weight for POS and inventory labels; do not add a per-variant unit or manual label control. Convert loaded weight values to strings before editing or validating them. Keep archived variants out of new POS sales, but preserve their records for history and restoration. Permit permanent deletion only while another variant remains.

Whole fish species such as Surmai or Bangda remain one catalog product. Fish inventory is an explicit exception to the reusable per-weight product-record model: it uses either per-fish batches or shared kilogram batches with configurable sale portions, all managed from Stock Adjustment.

**Why:** The user wants fish species to remain singular products while supporting both individually sized fish and bulk stock sold in portion sizes.

**How to apply:** Keep regular reusable weight variants for non-fish products. For fish, use the root species product and select individual-fish or bulk-portion stock mode; do not create weight sub-products for sale options.
