---
name: Pidge manual-allocation submissions
description: Pidge order submission behavior for FishTokri admin and storefront orders.
---

Pidge is configured for Manual Allocation. Submit an eligible FTS/FTW delivery order when it is confirmed; expect it to enter Pidge as Pending rather than being automatically assigned to a rider. Do not automatically retry a timeout or ambiguous server response because Pidge may already have created the order.

**Why:** The user chose production Pidge endpoints while keeping dispatch under manual review, and duplicate production orders would be confusing or harmful.

**How to apply:** Keep credentials server-side, send only delivery orders on the confirmation transition, persist dispatch state, and require checking Pidge before retrying an outcome marked uncertain.
