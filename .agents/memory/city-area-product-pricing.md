---
name: City/area product pricing
description: Business rules for customer city/area selection and delivery price adjustments.
---

For delivery orders, the customer must select a city/area from the active list for the chosen sub-hub. Add that area's configured charge to each catalog product unit price; do not add a separate pincode-based delivery fee. Keep postal codes as address data.

**Why:** The user replaced pincode-based charges with a city/area charge that is included in every product's price.

**How to apply:** Keep the city/area list and its charge in the sub-hub's MongoDB database, validate the selected value against that list when placing or editing delivery orders, and keep custom non-catalog items unadjusted unless the user changes the rule.
