---
name: Whole-fish inventory
description: Product and POS rules for fish sold whole at individually recorded weights and prices.
---

Each fish species is a single product, not a set of weight sub-products. Each incoming whole fish is recorded as its own batch with its weight in kilograms and its total price. The POS should show each eligible fish as a separate purchasable item and carry its exact batch ID through sale, deduction, and restoration. Only fish with positive stock, a saved weight and price, and an unexpired batch are sellable.

**Why:** The user sells each whole fish as it arrives; its weight and total price vary individually, and it must remain traceable as that exact fish.

**How to apply:** Keep species as product records and individual fish as inventory batches. Do not derive a per-kilogram selling price or combine separate fish into one POS line.
