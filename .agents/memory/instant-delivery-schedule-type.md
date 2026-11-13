---
name: Instant delivery schedule type
description: The required schedule type for delivery orders
---

All delivery orders should use `scheduleType: "instant"`; do not create delivery orders as `standard` or assign a scheduled time slot.

**Why:** The user said every order must be instant only.

**How to apply:** Keep order creation paths aligned with this rule, including FTS and FTW. Do not bulk-edit existing orders unless the user requests it.
