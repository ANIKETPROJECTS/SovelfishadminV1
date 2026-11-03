---
name: Whole-fish inventory
description: Product, pricing, stock, POS, and restoration rules for whole-fish and bulk-portion modes.
---

Each fish species is a single product, not a set of weight sub-products. When no explicit category is assigned, use the species/product name as its category in inventory and POS views. Fish products have two stock modes:

1. **Individual fish:** record each incoming fish as its own batch with its weight in kilograms. The product's customer selling rate per kilogram determines each fish's total price (`weight × rate`); POS shows each eligible fish separately and carries its exact batch ID through sale, deduction, and restoration.
2. **Bulk portions:** batches contain shared kilogram stock. Configure sale portion weights on the species product; POS and customer-menu data expose each weight and its calculated price. A sale deducts `pack count × portion weight` from eligible kilogram batches, and cancellation restores the exact allocations.

Only mode changes with no remaining stock are allowed. Store the fish rate and mode separately from the product's standard price and unit so switching modes does not overwrite the original catalog configuration. Do not silently rewrite existing individual-fish prices when loading a legacy product with varying historical prices; recalculate them only after the selling rate is explicitly changed. Calculate shelf life as the calendar-day difference between received date and expiry date, ignoring times. Derive it when older batches have both dates but no saved shelf-life value.

**Why:** The user distinguishes fish sold individually from products such as prawns purchased in bulk and sold in configured portions, with the same species remaining one catalog product. Legacy whole-fish batches can have different historical price-per-kg values, so deriving a default rate must not alter their saved prices; keeping the standard catalog price and unit also makes a mode change reversible.

**How to apply:** Use the individual-fish mode for one-fish-per-batch stock and the bulk-portion mode for shared kilogram batches. Keep sale options on the root fish product, store fish-specific rates separately, calculate customer prices from that rate, and persist exact batch allocations on sales so restores return stock to its source batches. Change modes only after stock is zero. Preserve date-only shelf-life arithmetic so times and timezone offsets do not change day counts.
