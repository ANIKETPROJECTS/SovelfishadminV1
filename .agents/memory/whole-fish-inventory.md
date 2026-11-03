---
name: Whole-fish inventory
description: Product and POS rules for fish sold whole at individually recorded weights and prices.
---

Each fish species is a single product, not a set of weight sub-products. When no explicit category is assigned, use the species/product name as its category in inventory and POS views. Each incoming whole fish is recorded as its own batch with its weight in kilograms and its total price. The POS should show each eligible fish as a separate purchasable item and carry its exact batch ID through sale, deduction, and restoration. Only fish with positive stock, a saved weight and price, and an unexpired batch are sellable.

Calculate shelf life as the calendar-day difference between received date and expiry date, ignoring the times. Derive it when an older batch has both dates but no saved shelf-life value, and save the derived value for newly added batches.

**Why:** The user sells each whole fish as it arrives; its weight and total price vary individually, and it must remain traceable as that exact fish. Existing records can have both dates but no shelf-life value, so the value must be derived consistently.

**How to apply:** Keep species as product records and individual fish as inventory batches. Do not derive a per-kilogram selling price or combine separate fish into one POS line. Use date-only arithmetic for shelf life so batch times and timezone offsets do not change the day count.
