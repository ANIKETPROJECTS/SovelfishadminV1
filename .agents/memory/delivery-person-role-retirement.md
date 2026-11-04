---
name: Delivery-person role retirement
description: Current policy for assigning the delivery-person role while preserving existing accounts.
---

Do not offer or assign the `delivery_person` role to new users. Keep existing accounts and delivery-specific code intact unless the user explicitly requests a migration or complete feature removal.

**Why:** The user no longer needs new delivery-person roles, while changing existing accounts could unexpectedly revoke access or disrupt legacy delivery assignments.

**How to apply:** Keep the role out of new-user and role-filter choices, reject new API assignments, and preserve existing accounts and role-specific behavior.
