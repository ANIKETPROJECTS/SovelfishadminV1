---
name: Delivery-person role retirement
description: Current policy for assigning the delivery-person role while preserving existing accounts.
---

Do not offer or assign the `delivery_person` role to new users, and do not expose manual delivery-partner assignment controls in the order list or detail panel. Delivery status changes must not require an assigned partner. Keep existing accounts, order history, and legacy delivery processing intact unless the user explicitly requests complete removal.

**Why:** The user no longer needs delivery-person roles or manual partner assignment, while changing existing accounts or historical orders could unexpectedly revoke access or erase context.

**How to apply:** Keep the role out of new-user and role-filter choices, reject new user-role assignments, hide order assignment controls, and preserve existing records and legacy routes.
