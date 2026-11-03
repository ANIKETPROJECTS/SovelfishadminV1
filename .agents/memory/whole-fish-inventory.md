---
name: Whole-fish inventory
description: Product and POS rules for fish sold whole at individually recorded weights and prices.
---

Each fish species is a single product, not a set of weight sub-products. When no explicit category is assigned, use the species/product name as its category in inventory and POS views. Inventory mode is product-specific: individually sold whole fish use one batch per fish with its weight in kilograms and total price; fish sold as combined stock use regular kilogram inventory with a per-kilogram price. For example, 10 kg of bulk stock can be received as one 10 kg lot and sold in 1 kg POS quantities. Whole-fish POS lines remain separate purchasable fish and carry their exact batch ID through sale, deduction, and restoration. Only fish with positive stock and an unexpired batch are sellable.

Calculate shelf life as the calendar-day difference between received date and expiry date, ignoring the times. Derive it when an older batch has both dates but no saved shelf-life value, and save the derived value for newly added batches.

**Why:** The user sells some fish whole at individual weights and total prices, while other fish arrive in combined stock and are sold by kilogram. These modes must not be forced into one batch model. Existing records can have both dates but no shelf-life value, so the value must be derived consistently.

**How to apply:** Keep one product per species. Use whole-fish tracking only for individually sold fish; use kg as the product unit and price basis for bulk stock. Do not derive a per-kilogram price for whole fish. Use date-only arithmetic for shelf life so batch times and timezone offsets do not change the day count.
