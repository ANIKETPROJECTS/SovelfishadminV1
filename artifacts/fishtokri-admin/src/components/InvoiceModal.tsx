/**
 * Shared invoice modal — used by both Orders and Day End Report.
 * Renders a Customer Invoice + KOT tab view with print support.
 */
import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { printHtmlWithQZ } from "@/lib/qz-print";
import { apiFetch } from "@/lib/api";
import { getInvoicePaymentAmounts, isInvoicePaid } from "@/lib/invoice-payment-status.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatRupees(n: number) {
  return `₹${Number(n || 0).toLocaleString("en-IN")}`;
}

function orderItemsTotal(items: any[]) {
  return (items ?? []).reduce(
    (s: number, i: any) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1),
    0,
  );
}

function formatTime12(t: string): string {
  const str = String(t).trim();
  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampmMatch) {
    const h = parseInt(ampmMatch[1], 10) % 12 || 12;
    return `${h}:${ampmMatch[2]} ${ampmMatch[3].toUpperCase()}`;
  }
  const m = str.match(/(\d{1,2}):(\d{2})/);
  if (!m) return str;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

export function formatTimeSlot(o: any): string | null {
  if (o?.timeslotStart && o?.timeslotEnd)
    return `${formatTime12(o.timeslotStart)} to ${formatTime12(o.timeslotEnd)}`;
  if (o?.timeslotLabel) {
    const m = String(o.timeslotLabel).match(/\(([^)]+)\)/);
    return m ? m[1].replace(/\s*[-–]\s*/, " to ") : o.timeslotLabel;
  }
  return null;
}

function modeDisplayLabel(mode: string, upiVariant?: string): string {
  const m = String(mode).trim().replace(/^custom_/i, "").toLowerCase();
  if (m === "upi" && upiVariant) return String(upiVariant).trim();
  if (m === "upi") return "UPI";
  if (m === "card") return "Card";
  if (m === "wallet") return "Wallet";
  if (m === "cash" || m === "cod" || m === "") return "COD";
  return m.toUpperCase();
}

function combinedPaymentLabel(order: any): string {
  const pays: any[] = Array.isArray(order?.payments) ? order.payments : [];
  const modes = pays
    .map((p: any) => String(p?.mode || "").toLowerCase().trim())
    .filter(Boolean);
  const hasWallet = modes.includes("wallet");
  const nonWallet = [...new Set(modes.filter((m) => m !== "wallet"))];
  if (hasWallet && nonWallet.length > 0) {
    return "Wallet + " + nonWallet.map((m) => modeDisplayLabel(m, order?.upiVariant)).join(" + ");
  }
  const rawMode = String(order?.paymentMode || modes[0] || "").toLowerCase().trim();
  return modeDisplayLabel(rawMode, order?.upiVariant);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function InvoiceModal({ order, onClose }: { order: any; onClose: () => void }) {
  const { toast } = useToast();
  const [qrDataUrl, setQrDataUrl] = useState("");
  const items: any[] = order.items ?? [];
  const subtotal =
    Number(order.subtotal) > 0 ? Number(order.subtotal) : orderItemsTotal(items);
  const totalQty = items.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0);
  const discount = Number(order.discount) || 0;
  const slotCharge = Number(order.slotCharge) || 0;
  const deliveryCharge = Number(order.deliveryCharge) || 0;
  const instantDeliveryCharge = Number(order.instantDeliveryCharge) || 0;
  const grandTotal = Math.max(
    0,
    subtotal - discount + slotCharge + deliveryCharge + instantDeliveryCharge,
  );
  const extraDiscAmt = Number(order.extraDiscount) || 0;
  const couponAmt = Math.max(0, discount - extraDiscAmt);
  const extraDiscType: string = order.extraDiscountType || "flat";
  const isPaid = isInvoicePaid(order);
  const { paidAmount: paidAmt, dueAmount: dueAmt } = getInvoicePaymentAmounts(order, grandTotal);
  const invPays: any[] = Array.isArray(order.payments) ? order.payments : [];
  const walletAmt = (() => {
    const w = invPays.find((p: any) => String(p?.mode || "").toLowerCase() === "wallet");
    return w ? Number(w.amount) || 0 : 0;
  })();

  const invoiceNo =
    order.orderId || order.invoiceNo || "INV-" + String(order._id || order.id || "").slice(-6).toUpperCase();

  useEffect(() => {
    const orderId = String(order?._id || order?.id || "");
    if (!orderId) return;
    let active = true;
    apiFetch(`/api/orders/${orderId}/qr-token`)
      .then((data) => QRCode.toDataURL(String(data.url || data.token), { width: 180, margin: 1, errorCorrectionLevel: "M" }))
      .then((url) => { if (active) setQrDataUrl(url); })
      .catch(() => {
        if (active) toast({ title: "QR unavailable", description: "The invoice loaded, but its delivery QR could not be generated.", variant: "destructive" });
      });
    return () => { active = false; };
  }, [order?._id, order?.id, toast]);
  const d = new Date(order.createdAt ?? Date.now());
  const orderDateStr = [
    String(d.getDate()).padStart(2, "0"),
    String(d.getMonth() + 1).padStart(2, "0"),
    d.getFullYear(),
  ].join("/");
  const deliveryDateStr = (() => {
    const s = String(order.deliveryDate ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, day] = s.split("-");
      return `${day}/${m}/${y}`;
    }
    return orderDateStr;
  })();
  const timeStr = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const payMode = combinedPaymentLabel(order);
  const payStatusNorm = String(order.paymentStatus || "").trim().toLowerCase();
  const payLabel = isPaid ? "Paid" : payStatusNorm === "partial" ? "Partial" : "Unpaid";
  const payStatusColor =
    isPaid ? "#15803d" : payStatusNorm === "partial" ? "#b45309" : "#b91c1c";
  const payStatusBg =
    isPaid ? "#f0fdf4" : payStatusNorm === "partial" ? "#fffbeb" : "#fef2f2";

  const slotLabel = order.isExpress ? "Express order by Porter" : formatTimeSlot(order);

  const [activeTab, setActiveTab] = useState<"customer" | "kot">("customer");

  const handlePrint = async () => {
    const itemRows = items
      .map((it: any) => {
        const qty = Number(it.quantity) || 1;
        const rate = Number(it.price) || 0;
        return `<tr><td style="padding:5px 4px;border:2px solid #444;font-weight:700;font-size:14px;word-break:break-word;">${it.name}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-size:14px;">${qty}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-size:14px;">${rate.toFixed(2)}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-size:14px;">${(qty * rate).toFixed(2)}</td></tr>`;
      })
      .join("");
    const kotItemRows = items
      .map((it: any) => {
        const qty = Number(it.quantity) || 1;
        return `<tr><td style="padding:5px 4px;border:2px solid #444;font-weight:700;font-size:15px;word-break:break-word;">${it.name}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-size:15px;">${qty}</td></tr>`;
      })
      .join("");

    const discountRows = [
      couponAmt > 0
        ? `<tr><td style="padding:4px 2px;border:2px solid #444;" colspan="3">Coupon${order.couponCode ? ` (${order.couponCode})` : ""} :</td><td style="padding:4px 2px;border:2px solid #444;text-align:right;">- ${couponAmt.toFixed(2)}</td></tr>`
        : "",
      extraDiscAmt > 0
        ? `<tr><td style="padding:4px 2px;border:2px solid #444;" colspan="3">Extra discount${extraDiscType === "percentage" ? " (%)" : ""} :</td><td style="padding:4px 2px;border:2px solid #444;text-align:right;">- ${extraDiscAmt.toFixed(2)}</td></tr>`
        : "",
      couponAmt === 0 && extraDiscAmt === 0 && discount > 0
        ? `<tr><td style="padding:4px 2px;border:2px solid #444;" colspan="3">Discount :</td><td style="padding:4px 2px;border:2px solid #444;text-align:right;">- ${discount.toFixed(2)}</td></tr>`
        : "",
    ].join("");
    const slotRow =
      slotCharge > 0
        ? `<tr><td style="padding:4px 2px;border:2px solid #444;" colspan="3">Delivery Charge :</td><td style="padding:4px 2px;border:2px solid #444;text-align:right;">+ ${slotCharge.toFixed(2)}</td></tr>`
        : "";
    const deliveryRow =
      deliveryCharge > 0
        ? `<tr><td style="padding:4px 2px;border:2px solid #444;" colspan="3">${order.isExpress ? "Porter Charge" : "Delivery Charge"} :</td><td style="padding:4px 2px;border:2px solid #444;text-align:right;">+ ${deliveryCharge.toFixed(2)}</td></tr>`
        : "";
    const walletRow =
      walletAmt > 0
        ? `<div style="display:flex;justify-content:space-between;margin:4px 0;font-size:17px;"><span>Wallet Applied:</span><span>− ${walletAmt.toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;margin:4px 0;font-size:18px;font-weight:700;"><span>Balance Due (Cash/UPI):</span><span>${Math.max(0, grandTotal - walletAmt).toFixed(2)}</span></div>`
        : "";
    const paidDueRow =
      isPaid || order.paidAmount !== undefined || order.dueAmount !== undefined
        ? `<div style="display:flex;justify-content:space-between;margin:8px 0 0;font-size:17px;"><span>Paid: <strong style="color:#16a34a;">₹${paidAmt.toFixed(2)}</strong></span><span>Due: <strong style="color:${dueAmt > 0 ? "#ef4444" : "#16a34a"};">₹${dueAmt.toFixed(2)}</strong></span></div>`
        : "";
    const upiTxnRow = order.upiTransactionId
      ? `<div style="margin:6px 0 0;font-size:14px;color:#555;"><b>UPI Txn ID:</b> <span style="font-family:monospace;">${order.upiTransactionId}</span></div>`
      : "";
    const notesRow = order.notes
      ? `<div style="margin:4px 0;font-size:17px;"><b>Notes : ${order.notes}</b></div>`
      : "";

    const headerHtml = `<div style="text-align:center;margin-bottom:4px;"><h2 style="font-size:22px;font-weight:800;margin:0 0 4px;">FRESH STOCK XCHANGE (ATHA FOODS Pvt Ltd)</h2><div style="font-size:14px;margin-top:4px;text-align:left;"><div><b>ADD :</b> Thane</div><div><b>Mob No :</b> 9220200100</div><div><b>GST No :</b> 27AAOCA7628P1ZT</div><div><b>FSSAI No :</b> 21521066000481</div></div></div>`;
    const commonInfoHtml =
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<div style="margin:4px 0;font-size:17px;"><b>Invoice :</b> ${invoiceNo}</div>` +
      `<div style="margin:4px 0;font-size:17px;"><b>Name :</b> ${order.customerName}</div>` +
      `<div style="margin:4px 0;font-size:17px;"><b>Mobile :</b> ${order.phone || "—"}</div>` +
      (order.address ? `<div style="margin:4px 0;font-size:17px;"><b>Address :</b> ${order.address}</div>` : "") +
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<div style="margin:4px 0;font-size:17px;"><b>Order Date :</b> ${orderDateStr} , ${timeStr}</div>` +
      `<div style="margin:4px 0;font-size:17px;"><b>Delivery Date :</b> ${deliveryDateStr}</div>` +
      (slotLabel ? `<div style="margin:4px 0;font-size:17px;"><b>Delivery Slot :</b> ${slotLabel}</div>` : "") +
      notesRow;

    const customerBody =
      `<div style="padding:6px 10px;font-size:18px;color:#111;">` +
      headerHtml +
      commonInfoHtml +
      `<div style="margin:4px 0;font-size:17px;"><b>Payment :</b> ${payMode} <span style="margin-left:5px;font-size:14px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:20px;border:1px solid ${payStatusColor};color:${payStatusColor};background:${payStatusBg};">${payLabel}</span></div>` +
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:4px 0;"><thead><tr><th style="padding:5px 4px;border:2px solid #444;text-align:left;font-weight:700;background:#f5f5f5;">Item</th><th style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;background:#f5f5f5;white-space:nowrap;">Qty</th><th style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;background:#f5f5f5;white-space:nowrap;">Rate</th><th style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;background:#f5f5f5;white-space:nowrap;">Amount</th></tr></thead><tbody>` +
      itemRows +
      `<tr><td style="padding:5px 4px;border:2px solid #444;font-weight:700;">Total Items: ${items.length}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;">${totalQty}</td><td style="padding:5px 4px;border:2px solid #444;"></td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;">${subtotal.toFixed(2)}</td></tr>` +
      discountRows + slotRow + deliveryRow +
      `</tbody></table>` +
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;margin:4px 0;"><span>Grand Total:</span><span>${grandTotal.toFixed(2)}</span></div>` +
      walletRow + paidDueRow + upiTxnRow +
      (qrDataUrl
        ? `<div style="text-align:center;margin-top:14px;"><div style="font-size:13px;font-weight:700;margin-bottom:4px;">Delivery partner QR</div><img src="${qrDataUrl}" alt="Delivery partner order QR" width="180" height="180" style="display:block;margin:0 auto;" /><div style="font-size:11px;font-weight:700;color:#555;margin-top:5px;">This QR is only for delivery person to scan.</div></div>`
        : "") +
      `<div style="text-align:center;font-size:15px;color:#555;line-height:1.8;margin-top:14px;">Thank you for your business!<br/>For any query - 9220200100</div></div>`;

    const kotBody =
      `<div style="padding:6px 10px;font-size:18px;color:#111;">` +
      headerHtml +
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<div style="text-align:center;font-weight:800;font-size:18px;letter-spacing:1px;margin:4px 0;">— KOT —</div>` +
      commonInfoHtml +
      `<div style="border-top:2px solid #444;margin:8px 0;"></div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:15px;margin:4px 0;"><thead><tr><th style="padding:5px 4px;border:2px solid #444;text-align:left;font-weight:700;background:#f5f5f5;">Item</th><th style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;background:#f5f5f5;">Qty</th></tr></thead><tbody>` +
      kotItemRows +
      `<tr><td style="padding:5px 4px;border:2px solid #444;font-weight:700;">Total Items: ${items.length}</td><td style="padding:5px 4px;border:2px solid #444;text-align:right;font-weight:700;">${totalQty}</td></tr></tbody></table></div>`;

    const PAGE_STYLE = `* { margin:0;padding:0;box-sizing:border-box; } body { font-family:Arial,sans-serif;color:#111;background:#fff; } @page { size:80mm auto;margin:0; }`;
    const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${invoiceNo} - Customer</title><style>${PAGE_STYLE}</style></head><body>${customerBody}</body></html>`;
    const kotHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${invoiceNo} - KOT</title><style>${PAGE_STYLE}</style></head><body>${kotBody}</body></html>`;

    toast({ title: "Printing..." });
    const qzResult = await printHtmlWithQZ(customerHtml);
    if (qzResult.success) {
      await printHtmlWithQZ(kotHtml);
      return;
    }
    toast({ title: "Print failed, opening dialog...", variant: "destructive" });
    const win1 = window.open("", "_blank");
    if (win1) {
      win1.document.write(customerHtml);
      win1.document.close();
      win1.focus();
      setTimeout(() => { win1.print(); win1.close(); }, 400);
    }
    setTimeout(() => {
      const win2 = window.open("", "_blank");
      if (win2) {
        win2.document.write(kotHtml);
        win2.document.close();
        win2.focus();
        setTimeout(() => { win2.print(); win2.close(); }, 400);
      }
    }, 1500);
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab("customer")}
              className={`px-3 py-1 text-sm font-medium rounded transition-colors ${activeTab === "customer" ? "bg-[#1A56DB] text-white" : "text-gray-500 hover:bg-gray-100"}`}
            >
              Customer Invoice
            </button>
            <button
              onClick={() => setActiveTab("kot")}
              className={`px-3 py-1 text-sm font-medium rounded transition-colors ${activeTab === "kot" ? "bg-[#1A56DB] text-white" : "text-gray-500 hover:bg-gray-100"}`}
            >
              KOT
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5 bg-gray-50">
          {activeTab === "customer" && (
            <div className="bg-white max-w-md mx-auto p-5 text-[16px] text-gray-800 shadow-sm border border-gray-200 rounded">
              <div style={{ textAlign: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.01em" }}>
                  FRESH STOCK XCHANGE (ATHA FOODS Pvt Ltd)
                </div>
                <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.6, textAlign: "left" }}>
                  <div><b>ADD :</b> Thane</div>
                  <div><b>Mob No :</b> 9220200100</div>
                  <div><b>GST No :</b> 27AAOCA7628P1ZT</div>
                  <div><b>FSSAI No :</b> 21521066000481</div>
                </div>
              </div>
              <div className="border-t-2 border-gray-500 my-2" />
              <div className="text-[15px]"><b>Invoice :</b> {invoiceNo}</div>
              <div className="text-[15px]"><b>Name :</b> {order.customerName}</div>
              <div className="text-[15px]"><b>Mobile :</b> {order.phone || "—"}</div>
              {order.address && <div className="text-[15px]"><b>Address :</b> {order.address}</div>}
              <div className="border-t-2 border-gray-500 my-2" />
              <div className="text-[15px]"><b>Order Date :</b> {orderDateStr} , {timeStr}</div>
              <div className="text-[15px]"><b>Delivery Date :</b> {deliveryDateStr}</div>
              {slotLabel && <div className="text-[15px]"><b>Delivery Slot :</b> {slotLabel}</div>}
              {order.notes && <div className="text-[15px]"><b>Notes : {order.notes}</b></div>}
              <div className="text-[15px]">
                <b>Payment :</b> {payMode}
                <span
                  data-testid="text-invoice-payment-status"
                  className={`ml-1 text-[13px] font-bold uppercase px-1.5 py-0.5 rounded-full border ${
                    isPaid
                      ? "text-green-700 bg-green-50 border-green-200"
                      : payStatusNorm === "partial"
                        ? "text-amber-700 bg-amber-50 border-amber-200"
                        : "text-red-700 bg-red-50 border-red-200"
                  }`}
                >
                  {payLabel}
                </span>
              </div>
              <div className="border-t-2 border-gray-500 my-2" />
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "left", fontWeight: 700, background: "#f5f5f5" }}>Item</th>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700, background: "#f5f5f5", whiteSpace: "nowrap" }}>Qty</th>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700, background: "#f5f5f5", whiteSpace: "nowrap" }}>Rate</th>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700, background: "#f5f5f5", whiteSpace: "nowrap" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it: any, i: number) => {
                    const qty = Number(it.quantity) || 1;
                    const rate = Number(it.price) || 0;
                    return (
                      <tr key={i}>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", fontWeight: 600, wordBreak: "break-word", maxWidth: 150 }}>{it.name}</td>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>{qty}</td>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>{rate.toFixed(2)}</td>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>{(qty * rate).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb", fontWeight: 700 }}>Total Items: {items.length}</td>
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700 }}>{totalQty}</td>
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} />
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700 }}>{subtotal.toFixed(2)}</td>
                  </tr>
                  {couponAmt > 0 && (
                    <tr>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} colSpan={3}>Coupon{order.couponCode ? ` (${order.couponCode})` : ""} :</td>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>- {couponAmt.toFixed(2)}</td>
                    </tr>
                  )}
                  {extraDiscAmt > 0 && (
                    <tr>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} colSpan={3}>Extra discount{extraDiscType === "percentage" ? " (%)" : ""} :</td>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>- {extraDiscAmt.toFixed(2)}</td>
                    </tr>
                  )}
                  {couponAmt === 0 && extraDiscAmt === 0 && discount > 0 && (
                    <tr>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} colSpan={3}>Discount :</td>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>- {discount.toFixed(2)}</td>
                    </tr>
                  )}
                  {slotCharge > 0 && (
                    <tr>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} colSpan={3}>Delivery Charge :</td>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>+ {slotCharge.toFixed(2)}</td>
                    </tr>
                  )}
                  {deliveryCharge > 0 && (
                    <tr>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb" }} colSpan={3}>{order.isExpress ? "Porter Charge" : "Delivery Charge"} :</td>
                      <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>+ {deliveryCharge.toFixed(2)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="border-t-2 border-gray-500 my-2" />
              <div className="flex justify-between text-[14px] font-bold">
                <span>Grand Total:</span>
                <span>{grandTotal.toFixed(2)}</span>
              </div>
              {walletAmt > 0 && (
                <>
                  <div className="flex justify-between text-[17px] mt-1">
                    <span>Wallet Applied:</span>
                    <span>− {walletAmt.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-[18px] font-bold mt-0.5">
                    <span>Balance Due (Cash/UPI):</span>
                    <span>{Math.max(0, grandTotal - walletAmt).toFixed(2)}</span>
                  </div>
                </>
              )}
              {(isPaid || order.paidAmount !== undefined || order.dueAmount !== undefined) && (
                <div className="flex justify-between text-[15px] mt-2">
                  <span>Paid: <strong className="text-green-600">{formatRupees(paidAmt)}</strong></span>
                  <span>Due: <strong className={dueAmt > 0 ? "text-red-500" : "text-green-600"}>{formatRupees(dueAmt)}</strong></span>
                </div>
              )}
              {order.upiTransactionId && (
                <div className="text-[13px] mt-1 text-gray-600">
                  <span className="font-semibold">UPI Txn ID:</span>{" "}
                  <span className="font-mono">{order.upiTransactionId}</span>
                </div>
              )}
              <div className="text-center mt-4">
                <div className="text-[13px] font-bold mb-1">Delivery partner QR</div>
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Order dispatch QR" width={180} height={180} className="mx-auto" />
                ) : (
                  <div className="h-[180px] flex items-center justify-center text-xs text-gray-400">Generating QR…</div>
                )}
                <div className="text-[11px] font-semibold text-gray-500 mt-1">
                  This QR is only for delivery person to scan.
                </div>
              </div>
              <div className="text-center text-[15px] text-gray-600 mt-3">
                Thank you for your business!<br />
                For any query - 9220200100
              </div>
            </div>
          )}

          {activeTab === "kot" && (
            <div className="bg-white max-w-md mx-auto p-5 text-[16px] text-gray-800 shadow-sm border border-gray-200 rounded">
              <div style={{ textAlign: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.01em" }}>FRESH STOCK XCHANGE (ATHA FOODS Pvt Ltd)</div>
                <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.6, textAlign: "left" }}>
                  <div><b>ADD :</b> Thane</div>
                  <div><b>Mob No :</b> 9220200100</div>
                  <div><b>GST No :</b> 27AAOCA7628P1ZT</div>
                  <div><b>FSSAI No :</b> 21521066000481</div>
                </div>
              </div>
              <div className="border-t-2 border-gray-500 my-2" />
              <div className="text-center font-bold text-[16px] tracking-widest mb-1">— KOT —</div>
              <div className="text-[15px]"><b>Invoice :</b> {invoiceNo}</div>
              <div className="text-[15px]"><b>Name :</b> {order.customerName}</div>
              <div className="text-[15px]"><b>Mobile :</b> {order.phone || "—"}</div>
              {order.address && <div className="text-[15px]"><b>Address :</b> {order.address}</div>}
              <div className="border-t-2 border-gray-500 my-2" />
              <div className="text-[15px]"><b>Order Date :</b> {orderDateStr} , {timeStr}</div>
              <div className="text-[15px]"><b>Delivery Date :</b> {deliveryDateStr}</div>
              {slotLabel && <div className="text-[15px]"><b>Delivery Slot :</b> {slotLabel}</div>}
              {order.notes && <div className="text-[15px]"><b>Notes : {order.notes}</b></div>}
              <div className="border-t-2 border-gray-500 my-2" />
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "left", fontWeight: 700, background: "#f5f5f5" }}>Item</th>
                    <th style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700, background: "#f5f5f5", whiteSpace: "nowrap" }}>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it: any, i: number) => {
                    const qty = Number(it.quantity) || 1;
                    return (
                      <tr key={i}>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", fontWeight: 600, wordBreak: "break-word" }}>{it.name}</td>
                        <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right" }}>{qty}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb", fontWeight: 700 }}>Total Items: {items.length}</td>
                    <td style={{ padding: "5px 4px", border: "1px solid #bbb", textAlign: "right", fontWeight: 700 }}>{totalQty}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-white">
          <Button variant="outline" onClick={onClose} className="h-9">Close</Button>
          <Button onClick={handlePrint} className="h-9 gap-1.5 bg-[#1A56DB] hover:bg-[#1447B4] text-white">
            <Printer className="w-3.5 h-3.5" /> Print Invoice
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
