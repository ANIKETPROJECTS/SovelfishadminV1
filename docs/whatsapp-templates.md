# Fresh Stock Xchange — WhatsApp Business Templates

Templates to submit to **Meta Business Manager → WhatsApp Manager → Message Templates** for approval.

---

## Step 0 — Delete the existing template

In Meta Business Manager → WhatsApp Manager → Message Templates, find `welcome_to_fishtokri` and click **Delete**.
(Only possible if it is not actively used by a running campaign.)

---

## Template 1 — Order Confirmed (Bill)

| Field             | Value                          |
|-------------------|--------------------------------|
| **Template Name** | `fishtokri_order_confirmed`    |
| **Category**      | **Utility**                    |
| **Language**      | English                        |

**Header (Text):**
```
Order Confirmed ✅
```

**Body:**
```
Hello {{1}},

Your Fresh Stock Xchange order has been *confirmed and accepted!*

*Order ID:* #{{2}}

*ORDER SUMMARY*
{{3}}

Subtotal:      ₹{{4}}
Discount:     -₹{{5}}
Delivery:      ₹{{6}}
*TOTAL:        ₹{{7}}*

*Payment:* {{8}}
*Deliver to:* {{9}}

Your fresh seafood is being prepared. We'll notify you when it's out for delivery!

— Team Fresh Stock Xchange
```

**Footer:**
```
Fresh Stock Xchange – Fresh from the sea to your door
```

**Sample variable values (required by Meta):**

| Variable | Sample Value |
|----------|-------------|
| `{{1}}` | Rahul Sharma |
| `{{2}}` | ORD-2847 |
| `{{3}}` | • Rohu Fish 1kg × 2 — ₹480\n• Tiger Prawns 500g × 1 — ₹350\n• Surmai Steak 500g × 1 — ₹280 |
| `{{4}}` | 1110 |
| `{{5}}` | 50 |
| `{{6}}` | 30 |
| `{{7}}` | 1090 |
| `{{8}}` | Cash on Delivery |
| `{{9}}` | 12, Sea View Apartments, Kochi – 682001 |

> **Why Utility gets approved:** The body is purely transactional — it is a bill summary triggered by a customer action (placing an order). No promotional language, no offers, no CTAs to buy more.

---

## Template 1b — Order Confirmed v2 (fixed item lines) — LIVE, replaces Template 1

> **Status: implemented and active.** The backend now sends this template
> (`fishtokri_confirmed`) for every order-confirmed notification. The old
> `fishtokri_order_confirmed` (Template 1, single free-text items variable)
> is retired and can be deleted from Admark/Meta.
>
> **Why a new template:** WhatsApp's Cloud API hard-rejects any template
> parameter value containing a literal newline (`\n`) — the whole send fails
> with `(#100) Invalid parameter`. A Unicode line-separator workaround
> (`U+2028`) was also tried and confirmed broken — it arrives as a garbled
> `�` character on the customer's phone. The only reliable way to get a
> genuine one-item-per-line layout is to make each item line **static
> template text** with its own variable, instead of packing a whole list
> into a single free-text variable.
>
> This template supports **5 item-line slots**. Orders with 5 or fewer items
> get one line each. Orders with **more than 5 items**: the first 4 items
> get their own line, and the 5th slot lists ALL remaining items together,
> joined with " | " on that one line (e.g. `5. Item A x1 - Rs.100 | 6. Item B
> x2 - Rs.200 | 7. Item C x1 - Rs.150`) — so nothing is dropped, it just
> stops being one-per-line beyond item 4. See `buildOrderConfirmedItemSlots()`
> in `artifacts/api-server/src/services/whatsapp.ts`.
>
> This also moves the delivery time onto its own dedicated line below the
> address (its own variable, not appended to the address text).

| Field             | Value                       |
|-------------------|------------------------------|
| **Template Name** | `fishtokri_confirmed`        |
| **Category**      | **Utility**                  |
| **Language**      | English                      |

**Header (Text):**
```
Order Confirmed ✅
```

**Body:**
```
Hello {{1}},

Your Fresh Stock Xchange order has been *confirmed and accepted!*

*Order ID:* #{{2}}

*ORDER SUMMARY*
{{3}}
{{4}}
{{5}}
{{6}}
{{7}}

Subtotal:      ₹{{8}}
Discount:     -₹{{9}}
Delivery:      ₹{{10}}
*TOTAL:        ₹{{11}}*

*Payment:* {{12}}
*Deliver to:* {{13}}
⏰ *Delivery Time:* {{14}}

Your fresh seafood is being prepared. We'll notify you when it's out for delivery!

— Team Fresh Stock Xchange
```

**Footer:**
```
Fresh Stock Xchange – Fresh from the sea to your door
```

**Sample variable values (required by Meta):**

| Variable | Sample Value |
|----------|-------------|
| `{{1}}`  | Rahul Sharma |
| `{{2}}`  | ORD-2847 |
| `{{3}}`  | 1. Rohu Fish 1kg x2 - Rs.480 |
| `{{4}}`  | 2. Tiger Prawns 500g x1 - Rs.350 |
| `{{5}}`  | 3. Surmai Steak 500g x1 - Rs.280 |
| `{{6}}`  | (single space) |
| `{{7}}`  | (single space) |
| `{{8}}`  | 1110 |
| `{{9}}`  | 50 |
| `{{10}}` | 30 |
| `{{11}}` | 1090 |
| `{{12}}` | Cash on Delivery |
| `{{13}}` | 12, Sea View Apartments, Kochi – 682001 |
| `{{14}}` | 03 Jul 2026, 09:30 PM - 10:30 PM |

> **Note on unused item slots:** orders with fewer than 5 items pass a
> single space `" "` for the unused `{{n}}` variables — Meta does not allow
> an empty string as a variable value. This renders as a blank line at the
> bottom of the item list; it's a minor, accepted cosmetic trade-off for a
> fixed-structure template with a variable-length list.
>
> **Template 1** (`fishtokri_order_confirmed`) is retired now that this
> template is live — it can be deleted from Admark/Meta.

---

## Template 2 — Out for Delivery (all orders — COD and UPI alike)

> **Update:** This single template is now used for every out-for-delivery
> notification regardless of payment mode. WhatsApp payment links are no
> longer sent for COD orders — the old "Template 3" (with an embedded
> Razorpay payment link) has been retired; see the removed section below
> for history if it's ever needed again.

| Field             | Value                              |
|-------------------|------------------------------------|
| **Template Name** | `fishtokri_out_for_delivery`       |
| **Category**      | **Utility**                        |
| **Language**      | English                            |

**Header (Text):**
```
Out for Delivery 🚚
```

**Body:**
```
Hello {{1}},

Your Fresh Stock Xchange order *#{{2}}* is now *Out for Delivery!*

*Your Delivery Partner:*
👤 {{3}}
📞 {{4}}

Feel free to call your delivery partner for live updates.

Thank you for choosing Fresh Stock Xchange!

— Team Fresh Stock Xchange
```

**Sample variable values:**

| Variable | Sample Value |
|----------|-------------|
| `{{1}}` | Rahul Sharma |
| `{{2}}` | ORD-2847 |
| `{{3}}` | Mohammed Arif |
| `{{4}}` | +91 98765 43210 |

---

## (Retired) Template 3 — Out for Delivery with Payment Link (COD orders only)

> **Removed — no longer used.** This variant (`fishtokri_out_for_delivery_cod` /
> `fishtokri_out_for_delivery_cod_new`) sent a Razorpay payment link so COD
> customers could pay online before the delivery partner arrived. Per product
> decision, WhatsApp order notifications no longer include payment links at
> all — **Template 2** (`fishtokri_out_for_delivery`) is now sent for every
> order regardless of payment mode. The old template can be deleted from
> Admark/Meta; it is kept here only as a historical reference in case the
> payment-link flow is ever revisited.

---

## Template 4 — Order Cancelled

| Field             | Value                        |
|-------------------|------------------------------|
| **Template Name** | `fishtokri_order_cancelled`  |
| **Category**      | **Utility**                  |
| **Language**      | English                      |

**Header (Text):**
```
Order Cancelled
```

**Body:**
```
Hello {{1}},

We're sorry — your Fresh Stock Xchange order *#{{2}}* has been *cancelled*.

*Reason:* {{3}}

If you paid online, your refund will be processed within *5–7 business days* to the original payment method.

We apologise for the inconvenience. Reach out to our support team if you have any questions.

We look forward to serving you again! 🐟

— Team Fresh Stock Xchange
```

**Sample variable values:**

| Variable | Sample Value                  |
|----------|-------------------------------|
| `{{1}}` | Rahul Sharma                   |
| `{{2}}` | ORD-2847                       |
| `{{3}}` | Item unavailable at hub        |

> **Tip for `{{3}}` — Cancellation reason:** Keep a small fixed list in the admin panel, for example:
> - Item unavailable at hub
> - Customer request
> - Hub closed
> - Delivery not possible to your area
>
> Meta reviewers check the sample value — keep it neutral and factual.

---

## Submission Checklist

- [ ] All templates use **Utility** category — cheaper per conversation than Marketing, approved faster
- [ ] Template names are lowercase with underscores, no spaces
- [ ] Every `{{n}}` variable has a realistic sample value filled in (Meta rejects templates with `{{1}}` left blank)
- [ ] `welcome_to_fishtokri` has been deleted from Meta dashboard
- [ ] Retired templates (`fishtokri_order_confirmed`, `fishtokri_out_for_delivery_cod` / `_cod_new`) deleted from Meta dashboard once confirmed unused
- [ ] Once approved (usually 24–48 hrs), backend integration can be implemented to fire these automatically on order status changes

---

## Approval Tips

- **Utility templates** are approved faster and cost less per conversation than Marketing. All active templates qualify as Utility because they are triggered by customer actions, not outbound promotions.
- **Avoid edits after submission.** If a template is rejected, you must create a new one with a different name — you cannot edit a submitted template.
