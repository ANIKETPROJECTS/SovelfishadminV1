---
name: Product preorder slot rules
description: Compatibility semantics for product-level recurring preorder timeslot restrictions
---

Product preorder availability may optionally include a timeslot allow-list keyed by weekday number. A missing weekday key is unrestricted; an explicit empty list disables every slot for that weekday.

**Why:** Existing products already use date and weekday availability without slot restrictions, so adding a default restriction would silently make legacy preorder products unavailable.

**How to apply:** Preserve omitted rules during API normalization and apply the rule only to preorder POS slot filtering. Intersect the allowed slots across every preorder product in the cart.

Direct ordering is the current operating mode: keep timeslot scheduling unavailable in the admin UI and API, and preserve the legacy scheduling implementation for possible future reactivation.

**Why:** The user asked for orders to be placed directly now while keeping the timeslot code available if they choose to use it later.

**How to apply:** Keep the admin and API scheduling feature flags aligned. Re-enable the legacy flow only when the user explicitly requests it, then verify the POS, sub-hub settings, API, and order messages together.