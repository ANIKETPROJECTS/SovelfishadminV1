---
name: Single cutting method per order item
description: The distinction between a product's available cutting methods and the method selected for an order item.
---

Each product may offer multiple reusable cutting methods, but a single order item may select at most one method. Leaving the item without a method is allowed.

**Why:** The user clarified that order staff must select cutting methods one at a time to avoid ambiguous preparation instructions.

**How to apply:** Keep multiple methods available in product configuration, use a single-choice control for each order item, and reject order input containing more than one distinct method.
