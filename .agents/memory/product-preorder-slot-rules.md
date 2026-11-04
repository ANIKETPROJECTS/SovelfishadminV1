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

Pincode time delay is legacy scheduling data. Do not show or apply it in the current direct-order workflow; preserve stored values and guarded timeslot code for possible future reactivation.

**Why:** The user asked to remove pincode time delay from current settings because timeslots are disabled, while retaining the legacy timeslot implementation.

**How to apply:** Keep delay controls and tooltips out of current pincode interfaces, and do not use pincode delay in direct-order calculations. Do not delete stored values or guarded scheduling code unless the user asks.

The direct-order flag must disable scheduling only; it must not skip delivery-address resolution or validation. Otherwise the saved address can remain visible in the form while the order payload has an empty address.

**Why:** A saved-address delivery order was rejected because address assembly was incorrectly guarded by the direct-order flag.

**How to apply:** Keep delivery address resolution independent of scheduling mode, and validate that both saved and new delivery addresses reach the order API.