import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Building2, Plus, Search, X, Trash2, ChevronDown, ChevronRight, ChevronLeft,
  Lock, PackageOpen, Calendar, Layers, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { getCurrentAdminScope } from "@/lib/api";
import { formatVariantLabelWithUnit, getProductUnitSuffix, normalizeProductUnit } from "@/lib/product-units";

function getToken() { return localStorage.getItem("fishtokri_token") ?? ""; }

async function apiFetch(path: string, options: RequestInit = {}) {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}`, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Request failed");
  return data;
}

function toInputDate(d: Date) { return d.toISOString().split("T")[0]; }
function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function calculateShelfLifeDays(receivedDate?: string | null, expiryDate?: string | null): number | null {
  const receivedDay = String(receivedDate ?? "").slice(0, 10);
  const expiryDay = String(expiryDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDay) || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDay)) return null;
  const received = Date.parse(`${receivedDay}T00:00:00Z`);
  const expiry = Date.parse(`${expiryDay}T00:00:00Z`);
  if (!Number.isFinite(received) || !Number.isFinite(expiry)) return null;
  const days = Math.round((expiry - received) / 86400000);
  return days >= 0 ? days : null;
}

type SuperHub = { id: string; name: string; location?: string };
type SubHub = { id: string; name: string; location?: string };
type Batch = {
  id: string;
  batchNumber: string;
  quantity: number;
  shelfLifeDays: number | null;
  receivedDate: string | null;
  expiryDate: string | null;
  expiryTime?: string;
  notes: string;
  fishWeightKg?: number | null;
  fishPrice?: number | null;
  fishPricePerKg?: number | null;
};
type FishInventoryMode = "standard" | "whole_fish" | "bulk_portions";
type BulkPortionOption = { weightKg: number; minWeightKg?: number; maxWeightKg?: number };
type BulkPortionOptionForm = { weightInput: string };
type Product = {
  id: string;
  name: string;
  variantGroupId?: string;
  variantLabel?: string;
  shortCode?: string;
  category: string;
  unit: string;
  price: number;
  quantity: number;
  batches?: Batch[];
  wholeFishInventory?: boolean;
  fishInventoryMode?: FishInventoryMode;
  fishPricePerKg?: number | null;
  bulkPortionWeightsKg?: number[];
  bulkPortionOptions?: BulkPortionOption[];
};

type ProductGroup = {
  id: string;
  name: string;
  category: string;
  unit: string;
  products: Product[];
  quantity: number;
  wholeFishInventory: boolean;
  fishInventoryMode: FishInventoryMode;
};

type AdjustmentCard = {
  key: string;
  groupId?: string;
  rows: Array<{ row: FormRow; idx: number }>;
};

function getProductGroupId(product: Product): string {
  return product.variantGroupId || product.id;
}

function getFishInventoryMode(product?: Product): FishInventoryMode {
  if (product?.fishInventoryMode === "bulk_portions") return "bulk_portions";
  if (product?.fishInventoryMode === "whole_fish" || product?.wholeFishInventory === true) return "whole_fish";
  return "standard";
}

function getFishPricePerKg(product?: Product): number | null {
  const savedRate = Number(product?.fishPricePerKg);
  if (Number.isFinite(savedRate) && savedRate > 0) return savedRate;
  if (getFishInventoryMode(product) === "whole_fish") {
    const batch = product?.batches?.find((item) =>
      Number(item.fishWeightKg) > 0 && Number(item.fishPrice) > 0,
    );
    if (batch) return Math.round((Number(batch.fishPrice) / Number(batch.fishWeightKg)) * 100) / 100;
  }
  return null;
}

function fishTotalPrice(weightKg: string | number, pricePerKg: string | number): string {
  const weight = Number(weightKg);
  const rate = Number(pricePerKg);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(rate) || rate <= 0) return "";
  return String(Math.round(weight * rate));
}

function bulkPortionPrice(weightKg: string | number, pricePerKg: string | number): string {
  const weight = Number(weightKg);
  const rate = Number(pricePerKg);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(rate) || rate <= 0) return "";
  return String(Math.round(weight * rate));
}

function bulkPortionLabel(weightKg: string | number): string {
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) return "";
  return weight < 1
    ? `${Math.round(weight * 1000)} g`
    : `${weight.toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
}

function parseBulkPortionInput(value: string): BulkPortionOption | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const firstWeightKg = Number(match[1]);
  if (!Number.isFinite(firstWeightKg) || firstWeightKg <= 0) return null;
  if (match[2] == null) return { weightKg: Math.round(firstWeightKg * 1000) / 1000 };
  const secondWeightKg = Number(match[2]);
  if (!Number.isFinite(secondWeightKg) || secondWeightKg <= firstWeightKg) return null;
  return {
    weightKg: Math.round(((firstWeightKg + secondWeightKg) / 2) * 1000) / 1000,
    minWeightKg: Math.round(firstWeightKg * 1000) / 1000,
    maxWeightKg: Math.round(secondWeightKg * 1000) / 1000,
  };
}

function bulkPortionOptionsForProduct(product?: Product): BulkPortionOptionForm[] {
  if (product?.bulkPortionOptions?.length) {
    return product.bulkPortionOptions.map((option) => ({
      weightInput: option.minWeightKg != null && option.maxWeightKg != null
        ? `${Number(option.minWeightKg)}-${Number(option.maxWeightKg)}`
        : String(Number(option.weightKg) || ""),
    }));
  }
  if (product?.bulkPortionWeightsKg?.length) {
    return product.bulkPortionWeightsKg.map((weightKg) => ({ weightInput: String(Number(weightKg) || "") }));
  }
  return ["0.5", "1", "2"].map((weightInput) => ({ weightInput }));
}

function bulkPortionOptionsForSave(options: BulkPortionOptionForm[]): BulkPortionOption[] {
  return options
    .map((option) => parseBulkPortionInput(option.weightInput) ?? { weightKg: Number.NaN })
    .sort((a, b) => a.weightKg - b.weightKg);
}

function bulkPortionDisplayLabel(option: BulkPortionOptionForm): string {
  const parsed = parseBulkPortionInput(option.weightInput);
  if (!parsed) return "Enter weight";
  if (parsed.minWeightKg != null && parsed.maxWeightKg != null) {
    return `${bulkPortionLabel(parsed.minWeightKg)}–${bulkPortionLabel(parsed.maxWeightKg)}`;
  }
  return bulkPortionLabel(parsed.weightKg);
}

function groupProducts(products: Product[]): ProductGroup[] {
  const grouped = new Map<string, Product[]>();
  for (const product of products) {
    const groupId = getProductGroupId(product);
    const members = grouped.get(groupId) ?? [];
    members.push(product);
    grouped.set(groupId, members);
  }

  return [...grouped.entries()].map(([id, members]) => {
    const fishInventoryMode = members
      .map((member) => getFishInventoryMode(member))
      .find((mode) => mode !== "standard") ?? "standard";
    const wholeFishInventory = fishInventoryMode === "whole_fish";
    const visibleMembers = fishInventoryMode !== "standard"
      ? members.filter((member) => member.id === id).slice(0, 1)
      : members;
    const productMembers = visibleMembers.length > 0 ? visibleMembers : members.slice(0, 1);
    productMembers.sort((a, b) => {
      if (a.id === id) return -1;
      if (b.id === id) return 1;
      return (a.variantLabel || "").localeCompare(b.variantLabel || "", undefined, { numeric: true });
    });
    const product = productMembers[0];
    return {
      id,
      name: product.name,
      category: product.category || "Uncategorized",
      unit: normalizeProductUnit(product.unit),
      products: productMembers,
      quantity: productMembers.reduce((total, member) => total + (Number(member.quantity) || 0), 0),
      wholeFishInventory,
      fishInventoryMode,
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

type FormMode = "add" | "remove" | "add_existing";
type FormRow = {
  productId: string;
  selectionGroupId?: string;
  productName: string;
  category: string;
  unit: string;
  price: string;
  quantityBefore: number;
  mode: FormMode;
  addQuantity: string;
  shelfLifeDays: string;
  expiryDate: string;
  expiryTime: string;
  batchNumber: string;
  removeQuantity: string;
  selectedBatchId: string;
  search: string;
  isWholeFishBatch: boolean;
  isBulkFishBatch: boolean;
  fishInventoryMode: FishInventoryMode;
  fishPricePerKg: string;
  bulkPortionOptions: BulkPortionOptionForm[];
  fishWeightKg: string;
  fishPrice: string;
};

type Adjustment = {
  _id: string;
  date: string;
  reason: string;
  superHubName?: string;
  subHubName?: string;
  items: Array<{
    productName: string; unit: string; quantityBefore: number; newQuantity: number; quantityAdjusted: number;
    mode?: string;
    batch?: { batchNumber?: string; quantity?: number; shelfLifeDays?: number | null; expiryDate?: string | null };
  }>;
  createdAt: string;
};

const REASONS = [
  "Stock damaged", "Stock wastage", "Stocking new inventory",
  "EXTRA SKU", "SKU TRANSFER", "Stock correction", "Other",
];

// ─── BATCH NUMBER GENERATION ─────────────────────────────────────────────────
function generateBatchPrefix(productName: string): string {
  const words = productName.trim().toUpperCase().replace(/[^A-Z\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "BAT";
  if (words.length === 1) {
    return words[0].slice(0, 3).padEnd(3, "X");
  }
  return (words[0].slice(0, 2) + words[1].slice(0, 2)).padEnd(4, "X");
}

/** Returns today's date as YYYYMMDD in IST (UTC+5:30). */
function getTodayYYYYMMDD(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Generates the next batch ID in the format: YYYYMMDD + ProductCode + PerProductSeq.
 *
 * If the product has a shortCode it is used directly as the prefix instead of
 * deriving one from the product name.
 *
 * Examples (shortCode "CBB"):
 *   First batch on 30 May 2026  → 20260530CBB01
 *   Second batch on 31 May 2026 → 20260531CBB02
 *
 * @param productName     Name of the product (fallback prefix source).
 * @param productBatches  Only the batches belonging to THIS product.
 * @param shortCode       Optional short code — used as prefix when provided.
 */
function generateNextBatchNumber(productName: string, productBatches: Array<Pick<Batch, "batchNumber">>, shortCode?: string): string {
  const prefix = shortCode && shortCode.trim() ? shortCode.trim().toUpperCase() : generateBatchPrefix(productName);
  const today = getTodayYYYYMMDD();
  let maxNum = 0;
  for (const b of productBatches) {
    if (!b.batchNumber) continue;
    const bn = b.batchNumber.toUpperCase();
    // Find where the prefix appears (skip the 8-char date portion)
    const prefixIdx = bn.indexOf(prefix);
    if (prefixIdx === -1) continue;
    // Extract only the part AFTER the prefix — must be 1–5 clean digits only.
    // Garbled names like "50050002" (>5 digits) or "5005.005e+22" are rejected
    // so they don't snowball the counter.
    const afterPrefix = bn.slice(prefixIdx + prefix.length);
    if (/^\d{1,5}$/.test(afterPrefix)) {
      const num = parseInt(afterPrefix, 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `${today}${prefix}${String(maxNum + 1).padStart(2, "0")}`;
}

function emptyRow(): FormRow {
  return {
    productId: "", productName: "", category: "", unit: "", price: "", quantityBefore: 0,
    mode: "add", addQuantity: "", shelfLifeDays: "", expiryDate: "", expiryTime: getCurrentTime12h(), batchNumber: "",
    removeQuantity: "", selectedBatchId: "", search: "",
    isWholeFishBatch: false, isBulkFishBatch: false, fishInventoryMode: "standard",
    fishPricePerKg: "", bulkPortionOptions: [], fishWeightKg: "", fishPrice: "",
  };
}

function addDaysISO(days: number, baseDate = toInputDate(new Date())): string {
  const safeBaseDate = /^\d{4}-\d{2}-\d{2}$/.test(baseDate) ? baseDate : toInputDate(new Date());
  const [year, month, day] = safeBaseDate.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + Math.trunc(days)));
  return d.toISOString().split("T")[0];
}

function parse12h(time: string): { h: number; m: number; ampm: "AM" | "PM" } {
  if (!time) return { h: 12, m: 0, ampm: "AM" };
  const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match) {
    return { h: parseInt(match[1], 10), m: parseInt(match[2], 10), ampm: match[3].toUpperCase() as "AM" | "PM" };
  }
  const [hStr, mStr] = time.split(":");
  let h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;
  const ampm: "AM" | "PM" = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h = h - 12;
  return { h, m, ampm };
}

function format12h(h: number, m: number, ampm: "AM" | "PM"): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

function to24hTime(time12h: string): string {
  const { h, m, ampm } = parse12h(time12h);
  let hour = h % 12;
  if (ampm === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getCurrentTime12h(): string {
  const now = new Date();
  const h24 = now.getHours();
  const m = now.getMinutes();
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return format12h(h, m, ampm);
}

/**
 * Extracts the time (12-h format) from a stored ISO string, correctly converted to IST.
 * MongoDB stores everything as UTC (e.g. "2026-07-07T08:45:00.000Z") so we must
 * shift by +05:30 before reading hours/minutes — never read raw T-digits from the string.
 * Falls back to "06:00 PM" (18:00 IST) for date-only strings or missing values.
 */
function extractTime12hFromISO(iso: string | null): string {
  if (!iso) return "06:00 PM";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "06:00 PM";
  // Convert UTC → IST by adding 5h30m
  const istMs = d.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const h24 = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  // Treat midnight IST as a sign that no real time was recorded — default to 6 PM
  if (h24 === 0 && m === 0) return "06:00 PM";
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return format12h(h, m, ampm);
}

function ClockPickerField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { h, m, ampm } = parse12h(value);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"hour" | "minute">("hour");

  const timeLabel = value
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`
    : "-- : --";

  const SIZE = 200;
  const CENTER = SIZE / 2;
  const R = 78;

  const hourItems = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const minuteItems = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const items = mode === "hour" ? hourItems : minuteItems;

  const handAngle = mode === "hour"
    ? ((h % 12) / 12) * 2 * Math.PI - Math.PI / 2
    : (m / 60) * 2 * Math.PI - Math.PI / 2;
  const handX = CENTER + R * Math.cos(handAngle);
  const handY = CENTER + R * Math.sin(handAngle);

  const handleClockClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = SIZE / rect.width;
    const scaleY = SIZE / rect.height;
    const x = (e.clientX - rect.left) * scaleX - CENTER;
    const y = (e.clientY - rect.top) * scaleY - CENTER;
    const dist = Math.sqrt(x * x + y * y);
    if (dist < 20) return;
    const rawAngle = Math.atan2(y, x);
    const clockAngle = ((rawAngle + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI));
    const idx = Math.round(clockAngle / (2 * Math.PI / 12)) % 12;
    if (mode === "hour") {
      onChange(format12h(hourItems[idx], m, ampm));
      setMode("minute");
    } else {
      onChange(format12h(h, minuteItems[idx], ampm));
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setMode("hour"); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 w-full h-8 px-2 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]"
        >
          <Clock className="w-3 h-3 text-gray-400 shrink-0" />
          <span className={value ? "text-[#162B4D]" : "text-gray-400"}>{timeLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-4" align="start" sideOffset={4}>
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Select Time</p>

        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setMode("hour")}
              className={`text-[36px] font-bold tabular-nums w-14 text-center rounded-lg py-0.5 transition-colors ${mode === "hour" ? "text-[#162B4D] bg-blue-50" : "text-gray-300 hover:text-gray-500"}`}
            >
              {String(h).padStart(2, "0")}
            </button>
            <span className="text-[36px] font-bold text-gray-200 select-none">:</span>
            <button
              type="button"
              onClick={() => setMode("minute")}
              className={`text-[36px] font-bold tabular-nums w-14 text-center rounded-lg py-0.5 transition-colors ${mode === "minute" ? "text-[#162B4D] bg-blue-50" : "text-gray-300 hover:text-gray-500"}`}
            >
              {String(m).padStart(2, "0")}
            </button>
          </div>
          <div className="flex flex-col ml-2">
            {(["AM", "PM"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(format12h(h, m, p))}
                className={`text-sm font-bold px-2 py-1 rounded-md transition-colors ${ampm === p ? "bg-[#162B4D] text-white" : "text-gray-300 hover:text-gray-600"}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMode("hour")}
            disabled={mode === "hour"}
            className="p-1 rounded-full text-gray-300 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-20 disabled:pointer-events-none transition-colors shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="flex-1 cursor-pointer"
            onClick={handleClockClick}
          >
            <circle cx={CENTER} cy={CENTER} r={CENTER - 1} fill="#F8FAFC" stroke="#E8EDF5" strokeWidth="1.5" />
            <line x1={CENTER} y1={CENTER} x2={handX} y2={handY} stroke="#364F9F" strokeWidth="2" strokeLinecap="round" />
            <circle cx={CENTER} cy={CENTER} r="4" fill="#364F9F" />
            <circle cx={handX} cy={handY} r="3.5" fill="#364F9F" />
            {items.map((item, i) => {
              const angle = (i / items.length) * 2 * Math.PI - Math.PI / 2;
              const x = CENTER + R * Math.cos(angle);
              const y = CENTER + R * Math.sin(angle);
              const isSelected = mode === "hour" ? h === item : m === item;
              return (
                <g key={item}>
                  {isSelected && <circle cx={x} cy={y} r="15" fill="#364F9F" />}
                  <text
                    x={x} y={y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="13"
                    fontWeight={isSelected ? "700" : "400"}
                    fill={isSelected ? "white" : "#4B5563"}
                    style={{ userSelect: "none", pointerEvents: "none" }}
                  >
                    {mode === "minute" ? String(item).padStart(2, "0") : item}
                  </text>
                </g>
              );
            })}
          </svg>

          <button
            type="button"
            onClick={() => setMode("minute")}
            disabled={mode === "minute"}
            className="p-1 rounded-full text-gray-300 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-20 disabled:pointer-events-none transition-colors shrink-0"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <p className="text-center text-[10px] text-gray-400 mt-2 font-semibold uppercase tracking-widest">
          {mode === "hour" ? "← Tap to set hour" : "Tap to set minute →"}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function formatExpiry(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const datePart = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
  if (!iso.includes("T")) return datePart;
  const timePart = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${datePart} ${timePart}`;
}

function daysUntil(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

// ─── LOCKED HUB BADGE ────────────────────────────────────────────────────────
function LockedHubBadge({ label, name, location }: { label: string; name: string; location?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 hidden sm:inline">{label}</span>
      <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 min-w-0">
        <Building2 className="w-3.5 h-3.5 text-[#364F9F] flex-shrink-0" />
        <span className="text-sm font-semibold text-[#162B4D] truncate">{name}</span>
        {location && <span className="text-[11px] text-gray-400 hidden md:inline truncate">· {location}</span>}
        <Lock className="w-3 h-3 text-gray-300 flex-shrink-0 ml-0.5" />
      </div>
    </div>
  );
}

// ─── PRODUCT SELECTOR ────────────────────────────────────────────────────────
function ProductSelector({
  row, idx, allProducts, usedGroupIds, onSelect, onClear, onSearchChange,
}: {
  row: FormRow;
  idx: number;
  allProducts: Product[];
  usedGroupIds: Set<string>;
  onSelect: (idx: number, group: ProductGroup) => void;
  onClear: (idx: number) => void;
  onSearchChange: (idx: number, val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedProduct = allProducts.find((product) => product.id === row.productId);
  const selectedGroupId = selectedProduct ? getProductGroupId(selectedProduct) : "";
  const availableGroups = groupProducts(allProducts).filter((group) =>
    !usedGroupIds.has(group.id) || group.id === selectedGroupId
  );
  const grouped: Record<string, ProductGroup[]> = {};
  for (const group of availableGroups) {
    const cat = group.category || "Uncategorized";
    (grouped[cat] = grouped[cat] || []).push(group);
  }
  const categories = Object.keys(grouped).sort();

  const q = row.search.trim().toLowerCase();
  const isSearching = q.length > 0;
  const searchResults = isSearching
    ? availableGroups.filter((group) =>
      group.name.toLowerCase().includes(q) ||
      group.category.toLowerCase().includes(q) ||
      group.products.some((product) =>
        formatVariantLabelWithUnit(product.variantLabel, product.unit).toLowerCase().includes(q)
      )
    )
    : [];

  function groupDescription(group: ProductGroup) {
    if (group.wholeFishInventory) return "Fish tracked by individual weight and price batches";
    const hasVariants = group.products.some((product) => Boolean(product.variantGroupId || product.variantLabel));
    if (!hasVariants) return group.category;
    const labels = group.products
      .filter((product) => Boolean(product.variantLabel))
      .map((product) => formatVariantLabelWithUnit(product.variantLabel, product.unit));
    return `${group.products.length} weight ${group.products.length === 1 ? "variant" : "variants"}${labels.length ? ` · ${labels.join(" · ")}` : ""}`;
  }

  function renderGroupOption(group: ProductGroup) {
    return (
      <button
        key={group.id}
        type="button"
        onMouseDown={(e) => { e.preventDefault(); onSelect(idx, group); doClose(); }}
        className="w-full text-left px-4 py-2.5 hover:bg-[#F05B4E]/5 transition-colors flex items-center justify-between gap-3 border-b border-gray-50 last:border-0"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#162B4D] truncate">{group.name}</p>
          <p className="text-xs text-gray-400 font-medium truncate">{groupDescription(group)}</p>
        </div>
        <p className="text-xs font-bold text-gray-500 flex-shrink-0">
          {group.quantity} <span className="font-normal text-gray-400">{getProductUnitSuffix(group.unit)}</span>
        </p>
      </button>
    );
  }

  function doClose() { setOpen(false); setSelectedCategory(null); }
  function doOpen() { if (!open) setSelectedCategory(null); setOpen(true); }
  function scheduleClose() { closeTimerRef.current = setTimeout(doClose, 120); }
  function cancelClose() { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (portalRef.current?.contains(target)) return;
      doClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  let style: React.CSSProperties = { display: "none" };
  if (open && wrapperRef.current) {
    const r = wrapperRef.current.getBoundingClientRect();
    style = {
      position: "fixed",
      bottom: window.innerHeight - r.top + 4,
      left: r.left,
      width: isSearching ? Math.max(r.width, 272) : 560,
      zIndex: 9999,
    };
  }

  const dropdown = (
    <div ref={portalRef} style={style} className="bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden"
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      {isSearching ? (
        <>
          <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Search results</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {searchResults.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-400 text-center">No products found</div>
            ) : searchResults.map(renderGroupOption)}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-[260px_300px]">
          <div className="border-r border-gray-100">
            <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50">
              <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Category</span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {categories.length === 0 ? (
                <div className="px-4 py-4 text-sm text-gray-400 text-center">No categories</div>
              ) : categories.map((cat) => (
                <button
                  key={cat} type="button"
                  onMouseEnter={() => setSelectedCategory(cat)}
                  onMouseDown={(e) => { e.preventDefault(); setSelectedCategory(cat); }}
                  className={`w-full text-left px-4 py-3 transition-colors flex items-center justify-between gap-2 border-b border-gray-50 last:border-0 ${
                    selectedCategory === cat ? "bg-[#364F9F]/5" : "hover:bg-[#364F9F]/5"
                  }`}
                >
                  <span className="text-sm font-semibold text-[#162B4D]">{cat}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[11px] text-gray-400 bg-gray-100 rounded-full px-2 py-0.5 font-semibold">{grouped[cat]?.length ?? 0}</span>
                    <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50">
              <span className="text-[11px] font-bold text-[#162B4D] uppercase tracking-widest">{selectedCategory ?? "Select a category"}</span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {selectedCategory === null ? (
                <div className="px-4 py-8 text-sm text-gray-400 text-center">Hover a category to see products</div>
              ) : (grouped[selectedCategory] ?? []).length === 0 ? (
                <div className="px-4 py-4 text-sm text-gray-400 text-center">No products</div>
              ) : (grouped[selectedCategory] ?? []).map(renderGroupOption)}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div ref={wrapperRef} className="relative w-full" onMouseEnter={() => { cancelClose(); doOpen(); }} onMouseLeave={scheduleClose}>
      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
      <input
        type="text" value={row.search}
        onChange={(e) => { onSearchChange(idx, e.target.value); setOpen(true); }}
        onFocus={doOpen}
        placeholder="Choose Product"
        className={`w-full h-9 pl-8 pr-8 text-sm font-medium border rounded-lg outline-none transition-all
          focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]
          ${row.productId ? "bg-[#364F9F]/5 border-[#364F9F]/30 text-[#162B4D]" : "border-gray-200 bg-white text-gray-500"}`}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2">
        {row.productId ? (
          <button type="button" onMouseDown={(e) => { e.preventDefault(); onClear(idx); doClose(); }}
            className="text-gray-400 hover:text-red-500 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform pointer-events-none ${open ? "rotate-180" : ""}`} />
        )}
      </div>
      {open && createPortal(dropdown, document.body)}
    </div>
  );
}

// ─── BATCH SELECTOR (for remove / add_existing modes) ────────────────────────
function BatchSelector({
  batches,
  unit,
  selectedBatchId,
  onSelect,
  mode = "remove",
}: {
  batches: Batch[];
  unit: string;
  selectedBatchId: string;
  onSelect: (batchId: string) => void;
  mode?: "remove" | "add_existing";
}) {
  const allActiveBatches = batches.filter((b) => {
    if (b.quantity <= 0) return false;
    if (b.expiryDate) {
      const exp = new Date(b.expiryDate);
      if (!isNaN(exp.getTime()) && exp.getTime() <= Date.now()) return false;
    }
    return true;
  });
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentActiveBatches = allActiveBatches.filter((b) =>
    !b.receivedDate || new Date(b.receivedDate).getTime() >= sevenDaysAgo
  );
  const [showAllBatches, setShowAllBatches] = useState(false);
  const activeBatches = showAllBatches ? allActiveBatches
    : recentActiveBatches.length > 0 ? recentActiveBatches : allActiveBatches;
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = activeBatches.find((b) => b.id === selectedBatchId);

  function scheduleClose() { closeTimerRef.current = setTimeout(() => setOpen(false), 120); }
  function cancelClose() { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || portalRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  let style: React.CSSProperties = { display: "none" };
  if (open && wrapperRef.current) {
    const r = wrapperRef.current.getBoundingClientRect();
    style = {
      position: "fixed",
      bottom: window.innerHeight - r.top + 4,
      left: r.left,
      minWidth: Math.max(r.width, 280),
      zIndex: 9999,
    };
  }

  const hiddenCount = allActiveBatches.length - recentActiveBatches.length;

  const dropdown = (
    <div ref={portalRef} style={style} className="bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden"
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
          {mode === "add_existing" ? "Select Batch to Add Into" : "Select Batch to Reduce"}
        </span>
        {hiddenCount > 0 && recentActiveBatches.length > 0 && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setShowAllBatches((v) => !v); }}
            className="text-[10px] font-semibold text-[#364F9F] hover:underline flex-shrink-0"
          >
            {showAllBatches ? "Last 7 days" : `Show all (${allActiveBatches.length})`}
          </button>
        )}
      </div>
      <div className="max-h-56 overflow-y-auto">
        {mode === "remove" && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onSelect(""); setOpen(false); }}
            className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors border-b border-gray-50 flex items-center gap-2 ${!selectedBatchId ? "bg-amber-50" : ""}`}
          >
            <span className="text-sm font-medium text-gray-500 italic">FIFO (auto — earliest expiry first)</span>
          </button>
        )}
        {activeBatches.length === 0 ? (
          <div className="px-4 py-4 text-sm text-gray-400 text-center">No active batches</div>
        ) : activeBatches.map((b) => {
          const dl = daysUntil(b.expiryDate);
          const tone = dl == null ? "text-gray-500"
            : dl < 0 ? "text-red-600"
            : dl <= 7 ? "text-amber-600"
            : "text-emerald-600";
          return (
            <button
              key={b.id} type="button"
              onMouseDown={(e) => { e.preventDefault(); onSelect(b.id); setOpen(false); }}
              className={`w-full text-left px-4 py-3 hover:bg-[#364F9F]/5 transition-colors border-b border-gray-50 last:border-0 ${selectedBatchId === b.id ? "bg-[#364F9F]/5" : ""}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-[#162B4D]">{b.batchNumber || "Unnamed Batch"}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {b.fishWeightKg != null
                      ? `${b.fishWeightKg} kg · ₹${Math.round(Number(b.fishPrice ?? 0))} per fish · `
                      : ""}
                    Added {formatDate(b.receivedDate)} · Exp <span className={`font-semibold ${tone}`}>{formatExpiry(b.expiryDate)}</span>
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-[#162B4D]">{b.quantity}</p>
                  <p className="text-[11px] text-gray-400">{unit}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const placeholder = mode === "add_existing" ? "Select a batch" : "FIFO (auto)";
  const selectedStyle = mode === "add_existing"
    ? "bg-[#364F9F]/5 border-[#364F9F]/30 text-[#162B4D]"
    : "bg-amber-50 border-amber-200 text-[#162B4D]";

  return (
    <div ref={wrapperRef} className="relative w-full" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full h-9 px-3 text-sm font-medium text-left border rounded-lg outline-none transition-all flex items-center justify-between gap-2
          focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]
          ${selected ? selectedStyle : "border-gray-200 bg-white text-gray-400"}`}
      >
        <span className="truncate">
          {selected
            ? `${selected.batchNumber || "Unnamed"}${selected.fishWeightKg != null ? ` · ${selected.fishWeightKg} kg · ₹${Math.round(Number(selected.fishPrice ?? 0))}` : ""}`
            : placeholder}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && createPortal(dropdown, document.body)}
    </div>
  );
}

// ─── EXISTING BATCHES CARD (editable) ────────────────────────────────────────
function ExistingBatchesCard({
  batches, unit, productId, subHubId, onReload, wholeFishProduct = false, fishPricePerKg = null,
}: {
  batches: Batch[];
  unit: string;
  productId: string;
  subHubId: string;
  onReload: () => void;
  wholeFishProduct?: boolean;
  fishPricePerKg?: number | null;
}) {
  const { toast } = useToast();
  const [edited, setEdited] = useState<Batch[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAllBatches, setShowAllBatches] = useState(false);

  // Compute which batches to show (last 7 days by receivedDate)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentBatches = batches.filter((b) =>
    !b.receivedDate || new Date(b.receivedDate).getTime() >= sevenDaysAgo
  );
  const visibleBatches = showAllBatches ? batches
    : recentBatches.length > 0 ? recentBatches : batches;
  const hiddenCount = batches.length - recentBatches.length;

  // Sync local edit state when the batch list changes or the visible range changes.
  useEffect(() => {
    setEdited(visibleBatches.map((b) => ({
      ...b,
      shelfLifeDays: b.shelfLifeDays ?? calculateShelfLifeDays(b.receivedDate, b.expiryDate),
      ...(wholeFishProduct
        ? {
            ...(Number(b.fishPricePerKg) > 0 ? { fishPricePerKg: Number(b.fishPricePerKg) } : {}),
            fishPrice: Number(b.fishPricePerKg) > 0 && Number(b.fishWeightKg) > 0
              ? Math.round(Number(b.fishWeightKg) * Number(b.fishPricePerKg))
              : b.fishPrice != null && b.fishPrice !== "" && Number.isFinite(Number(b.fishPrice))
                ? Math.round(Number(b.fishPrice))
                : b.fishPrice,
          }
        : {}),
      expiryTime: extractTime12hFromISO(b.expiryDate),
    })));
    setDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, showAllBatches, fishPricePerKg, wholeFishProduct]);

  if (batches.length === 0) return null;

  function patchBatch(idx: number, patch: Partial<Batch>) {
    setEdited((prev) => prev.map((b, i) => i === idx ? { ...b, ...patch } : b));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Strip UI-only expiryTime and reconstruct expiryDate as a full IST ISO string
      const batchesToSend = edited.map(({ expiryTime, ...rest }) => ({
        ...rest,
        ...(wholeFishProduct
          ? {
              ...(Number(rest.fishPricePerKg) > 0 ? { fishPricePerKg: Number(rest.fishPricePerKg) } : {}),
              fishPrice: Number(rest.fishPricePerKg) > 0 && Number(rest.fishWeightKg) > 0
                ? Math.round(Number(rest.fishWeightKg) * Number(rest.fishPricePerKg))
                : rest.fishPrice != null && rest.fishPrice !== "" && Number.isFinite(Number(rest.fishPrice))
                  ? Math.round(Number(rest.fishPrice))
                  : rest.fishPrice,
            }
          : {}),
        expiryDate: rest.expiryDate
          ? `${rest.expiryDate.slice(0, 10)}T${to24hTime(expiryTime || "06:00 PM")}:00+05:30`
          : rest.expiryDate,
      }));
      await apiFetch(`/api/inventory/products/${productId}/batches?subHubId=${subHubId}`, {
        method: "PUT",
        body: JSON.stringify({ batches: batchesToSend }),
      });
      toast({ title: "Batches updated successfully" });
      setDirty(false);
      onReload();
    } catch (err: any) {
      toast({ title: "Failed to save batches", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEdited(batches.map((b) => ({
      ...b,
      shelfLifeDays: b.shelfLifeDays ?? calculateShelfLifeDays(b.receivedDate, b.expiryDate),
      expiryTime: extractTime12hFromISO(b.expiryDate),
    })));
    setDirty(false);
  }

  return (
    <div className="rounded-xl border border-[#364F9F]/15 bg-[#364F9F]/3 overflow-hidden">
      <div className="flex items-center px-4 py-2 bg-[#364F9F]/8">
        <Layers className="w-3.5 h-3.5 text-[#364F9F]" />
        <span className="ml-2 text-[11px] font-bold text-[#364F9F] uppercase tracking-widest flex-1">
          Existing Batches ({showAllBatches ? batches.length : `${visibleBatches.length} recent`})
        </span>
        {hiddenCount > 0 && recentBatches.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAllBatches((v) => !v)}
            className="px-3 py-1.5 bg-white hover:bg-[#364F9F]/5 border border-[#364F9F]/15 rounded-md text-[10px] font-bold text-[#364F9F] uppercase tracking-wide transition-colors whitespace-nowrap"
          >
            {showAllBatches ? "Last 7 days" : `Show all (${batches.length})`}
          </button>
        )}
      </div>

      <>
        {/* Column headers */}
          <div className="px-3 py-1.5 bg-[#364F9F]/5 border-y border-[#364F9F]/10">
            <div className={`grid ${wholeFishProduct ? "min-w-[980px] grid-cols-7" : "grid-cols-5"} gap-2`}>
              <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Batch ID</span>
              {wholeFishProduct && <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Weight (kg)</span>}
              {wholeFishProduct && <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Price / fish</span>}
              <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">{wholeFishProduct ? "Fish stock (0 or 1)" : `Qty (${unit})`}</span>
              <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Shelf Life (d)</span>
              <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Received</span>
              <span className="text-[10px] font-bold text-[#364F9F] uppercase tracking-wider">Expiry Date &amp; Time</span>
            </div>
          </div>

          {/* Editable rows */}
          <div className="divide-y divide-[#364F9F]/10">
            {edited.map((b, i) => {
              const dl = daysUntil(b.expiryDate);
              const expColor = dl == null ? "border-gray-200"
                : dl < 0 ? "border-red-300 bg-red-50"
                : dl <= 7 ? "border-amber-300 bg-amber-50"
                : "border-emerald-200 bg-emerald-50";
              return (
                <div key={b.id} className={`px-3 py-2 grid ${wholeFishProduct ? "min-w-[980px] grid-cols-7" : "grid-cols-5"} gap-2 items-start bg-white/50 hover:bg-white/80 transition-colors`}>
                  <input
                    type="text"
                    value={b.batchNumber}
                    onChange={(e) => patchBatch(i, { batchNumber: e.target.value.toUpperCase() })}
                    className="h-7 px-2 text-[11px] font-bold font-mono text-[#162B4D] border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 uppercase mt-0.5"
                  />
                  {wholeFishProduct && (
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={b.fishWeightKg ?? ""}
                      onChange={(e) => patchBatch(i, { fishWeightKg: e.target.value === "" ? null : Number(e.target.value) })}
                      aria-label="Fish weight in kilograms"
                      className="h-7 px-2 text-[11px] text-[#162B4D] border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 mt-0.5"
                    />
                  )}
                  {wholeFishProduct && (
                    <input
                      type="number"
                      value={Number(b.fishPricePerKg) > 0 && Number(b.fishWeightKg) > 0
                       ? String(Math.round(Number(b.fishWeightKg) * Number(b.fishPricePerKg)))
                        : wholeFishProduct && b.fishPrice != null && b.fishPrice !== "" && Number.isFinite(Number(b.fishPrice))
                          ? String(Math.round(Number(b.fishPrice)))
                          : b.fishPrice ?? ""}
                      aria-label="Calculated total price for this fish"
                      readOnly
                      className="h-7 px-2 text-[11px] text-[#162B4D] border border-gray-200 rounded bg-gray-50 mt-0.5"
                    />
                  )}
                  <input
                    type="number"
                    min="0"
                    max={wholeFishProduct ? 1 : undefined}
                    step={wholeFishProduct ? 1 : undefined}
                    value={b.quantity}
                    onChange={(e) => patchBatch(i, { quantity: Number(e.target.value) })}
                    className="h-7 px-2 text-[11px] font-bold text-[#162B4D] border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 mt-0.5"
                  />
                  <input
                    type="number"
                    min="0"
                    value={b.shelfLifeDays ?? ""}
                    onChange={(e) => {
                      const days = e.target.value === "" ? null : Number(e.target.value);
                      let expiryDate = b.expiryDate;
                      if (days !== null && b.receivedDate) {
                        const dateISO = addDaysISO(days, b.receivedDate.slice(0, 10));
                        expiryDate = `${dateISO}T${to24hTime(b.expiryTime || "06:00 PM")}:00+05:30`;
                      }
                      patchBatch(i, { shelfLifeDays: days, expiryDate });
                    }}
                    placeholder="—"
                    className="h-7 px-2 text-[11px] text-[#162B4D] border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 mt-0.5"
                  />
                  <input
                    type="date"
                    value={b.receivedDate?.slice(0, 10) ?? ""}
                    onChange={(e) => {
                      const received = e.target.value || null;
                      const patch: Partial<Batch> = {
                        receivedDate: received,
                        shelfLifeDays: calculateShelfLifeDays(received, b.expiryDate),
                      };
                      patchBatch(i, patch);
                    }}
                    className="h-7 px-2 text-[11px] text-[#162B4D] border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 mt-0.5"
                  />
                  {/* Expiry date + time stacked */}
                  <div className="space-y-1">
                    <input
                      type="date"
                      value={b.expiryDate?.slice(0, 10) ?? ""}
                      onChange={(e) => {
                        const dateVal = e.target.value || null;
                        const patch: Partial<Batch> = {};
                        if (dateVal) {
                          patch.expiryDate = `${dateVal}T${to24hTime(b.expiryTime || "06:00 PM")}:00+05:30`;
                          patch.shelfLifeDays = calculateShelfLifeDays(b.receivedDate, dateVal);
                        } else {
                          patch.expiryDate = null;
                          patch.shelfLifeDays = null;
                        }
                        patchBatch(i, patch);
                      }}
                      className={`w-full h-7 px-2 text-[11px] text-[#162B4D] border rounded focus:outline-none focus:ring-1 focus:ring-[#364F9F]/30 ${expColor}`}
                    />
                    <ClockPickerField
                      value={b.expiryTime || "06:00 PM"}
                      onChange={(v) => {
                        const patch: Partial<Batch> = { expiryTime: v };
                        if (b.expiryDate) {
                          patch.expiryDate = `${b.expiryDate.slice(0, 10)}T${to24hTime(v)}:00+05:30`;
                        }
                        patchBatch(i, patch);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Save / Cancel toolbar */}
          {dirty && (
            <div className="px-3 py-2 bg-[#364F9F]/5 border-t border-[#364F9F]/10 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancel}
                className="text-[11px] font-semibold text-gray-500 hover:text-gray-700 px-3 py-1 rounded border border-gray-200 bg-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="text-[11px] font-semibold text-white bg-[#364F9F] hover:bg-[#2a3d7a] px-3 py-1 rounded transition-colors disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          )}
      </>
    </div>
  );
}

function WholeFishAdjustmentTable({
  rows,
  product,
  subHubId,
  onUpdate,
  onAdd,
  onRemove,
  onReload,
  onRateChange,
  onWeightChange,
}: {
  rows: Array<{ row: FormRow; idx: number }>;
  product: Product | undefined;
  subHubId: string;
  onUpdate: (idx: number, patch: Partial<FormRow>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onReload: () => void;
  onRateChange: (value: string) => void;
  onWeightChange: (idx: number, value: string) => void;
}) {
  const batches: Batch[] = product?.batches ?? [];
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[#364F9F]/15 bg-[#364F9F]/[0.025] p-3">
        <div className="w-52 space-y-1">
          <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Customer selling price / kg</Label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-400">₹</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={rows[0]?.row.fishPricePerKg ?? ""}
              onChange={(event) => onRateChange(event.target.value)}
              placeholder="e.g. 600"
              aria-label="Customer selling price per kilogram"
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm font-semibold text-[#162B4D] outline-none focus:border-[#364F9F] focus:ring-2 focus:ring-[#364F9F]/15"
            />
          </div>
        </div>
        <p className="pb-2 text-xs text-gray-500">Each fish’s total price is calculated from its weight and this rate.</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead className="bg-gray-50">
            <tr>
              {["#", "Weight (kg)", "Total price per fish", "Stock unit", "Expiry date & time", "Batch ID", ""].map((heading, index) => (
                <th key={`${heading}-${index}`} className="border-b border-r border-gray-200 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 last:border-r-0">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, idx }, rowNumber) => (
              <tr key={`${row.batchNumber}-${idx}`} className="bg-white hover:bg-gray-50/60">
                <td className="w-10 border-b border-r border-gray-200 px-2 py-2 text-xs font-semibold text-gray-500">{rowNumber + 1}</td>
                <td className="border-b border-r border-gray-200 px-2 py-2">
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    inputMode="decimal"
                    value={row.fishWeightKg}
                    onChange={(event) => onWeightChange(idx, event.target.value)}
                    placeholder="e.g. 1.2"
                    aria-label={`Weight in kilograms for fish ${rowNumber + 1}`}
                    className="h-9 w-full rounded-md border border-gray-200 px-2 text-sm font-semibold text-[#162B4D] outline-none focus:border-[#364F9F] focus:ring-2 focus:ring-[#364F9F]/15"
                  />
                </td>
                <td className="border-b border-r border-gray-200 px-2 py-2">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">₹</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={row.fishPrice}
                      placeholder="Calculated"
                      aria-label={`Total price for fish ${rowNumber + 1}`}
                      readOnly
                      className="h-9 w-full rounded-md border border-gray-200 bg-gray-50 px-2 text-sm font-semibold text-[#162B4D]"
                    />
                  </div>
                </td>
                <td className="border-b border-r border-gray-200 px-2 py-2 text-xs font-semibold text-[#162B4D]">1 fish</td>
                <td className="border-b border-r border-gray-200 px-2 py-2">
                  <div className="flex min-w-[220px] items-center gap-1.5">
                    <input
                      type="date"
                      value={row.expiryDate}
                      onChange={(event) => onUpdate(idx, { expiryDate: event.target.value, shelfLifeDays: "" })}
                      aria-label={`Expiry date for fish ${rowNumber + 1}`}
                      className="h-9 min-w-0 flex-1 rounded-md border border-gray-200 px-1.5 text-[11px] font-medium text-[#162B4D]"
                    />
                    <div className="w-[108px] shrink-0">
                      <ClockPickerField value={row.expiryTime} onChange={(value) => onUpdate(idx, { expiryTime: value })} />
                    </div>
                  </div>
                </td>
                <td className="border-b border-r border-gray-200 px-2 py-2">
                  <input
                    type="text"
                    value={row.batchNumber}
                    onChange={(event) => onUpdate(idx, { batchNumber: event.target.value.toUpperCase() })}
                    aria-label={`Batch ID for fish ${rowNumber + 1}`}
                    className="h-9 w-full rounded-md border border-[#364F9F]/25 bg-[#364F9F]/5 px-2 text-[11px] font-bold tracking-wide text-[#364F9F]"
                  />
                </td>
                <td className="border-b border-gray-200 px-2 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    disabled={rows.length <= 1}
                    aria-label={`Remove fish entry ${rowNumber + 1}`}
                    className="rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[#364F9F]/35 px-3 py-2 text-xs font-semibold text-[#364F9F] hover:bg-[#364F9F]/5"
      >
        <Plus className="h-3.5 w-3.5" /> Add another fish
      </button>
      {batches.length > 0 && (
        <ExistingBatchesCard
          batches={batches}
          unit="fish"
          productId={product?.id ?? ""}
          subHubId={subHubId}
          onReload={onReload}
          wholeFishProduct
          fishPricePerKg={getFishPricePerKg(product)}
        />
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function InventoryStockAdjustment() {
  const { toast } = useToast();
  const [superHubs, setSuperHubs] = useState<SuperHub[]>([]);
  const [subHubs, setSubHubs] = useState<SubHub[]>([]);
  const [selectedSuperHubId, setSelectedSuperHubId] = useState("");
  const [selectedSubHubId, setSelectedSubHubId] = useState("");
  const [selectedSuperHub, setSelectedSuperHub] = useState<SuperHub | null>(null);
  const [selectedSubHub, setSelectedSubHub] = useState<SubHub | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingPriceProductId, setSavingPriceProductId] = useState("");
  const [expandedBatchProductId, setExpandedBatchProductId] = useState("");

  const [formDate, setFormDate] = useState(toInputDate(new Date()));
  const [formReason, setFormReason] = useState("");
  const [formRows, setFormRows] = useState<FormRow[]>([emptyRow()]);

  useEffect(() => {
    apiFetch("/api/super-hubs")
      .then((d) => setSuperHubs(d.superHubs ?? []))
      .catch((err) => toast({ title: "Failed to load super hubs", description: err.message, variant: "destructive" }));
  }, [toast]);

  const adminScope = useMemo(() => getCurrentAdminScope(), []);

  useEffect(() => {
    if (!superHubs.length) return;
    if (selectedSuperHubId) return;
    setSelectedSuperHubId(superHubs[0].id);
    setSelectedSuperHub(superHubs[0]);
  }, [superHubs]);

  useEffect(() => {
    if (!selectedSuperHubId) { setSubHubs([]); setSelectedSubHubId(""); setSelectedSuperHub(null); return; }
    const sh = superHubs.find((h) => h.id === selectedSuperHubId);
    if (sh) setSelectedSuperHub(sh);
    apiFetch(`/api/super-hubs/${selectedSuperHubId}/sub-hubs`)
      .then((d) => setSubHubs(d.subHubs ?? []))
      .catch((err) => toast({ title: "Failed to load sub hubs", description: err.message, variant: "destructive" }));
    setSelectedSubHubId("");
    setSelectedSubHub(null);
  }, [selectedSuperHubId, toast]);

  useEffect(() => {
    if (!subHubs.length) return;
    if (selectedSubHubId) return;
    setSelectedSubHubId(subHubs[0].id);
    setSelectedSubHub(subHubs[0]);
  }, [subHubs]);

  useEffect(() => {
    const sh = subHubs.find((h) => h.id === selectedSubHubId);
    if (sh) setSelectedSubHub(sh);
  }, [selectedSubHubId, subHubs]);

  const reload = useCallback(() => {
    if (!selectedSubHubId) { setProducts([]); return; }
    apiFetch(`/api/inventory/products?subHubId=${selectedSubHubId}`)
      .then((res) => setProducts(res.products ?? []))
      .catch((err) => toast({ title: "Failed to load products", description: err.message, variant: "destructive" }));
  }, [selectedSubHubId, toast]);

  useEffect(reload, [reload]);

  function addRow() { setFormRows((rows) => [...rows, emptyRow()]); }
  function removeRow(i: number) { setFormRows((rows) => rows.filter((_, idx) => idx !== i)); }
  function updateRow(i: number, patch: Partial<FormRow>) {
    setFormRows((rows) => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }

  function updateFishPricePerKg(card: AdjustmentCard, value: string) {
    if (!card.groupId) return;
    setFormRows((rows) => rows.map((row) => row.selectionGroupId === card.groupId
      ? { ...row, fishPricePerKg: value, fishPrice: fishTotalPrice(row.fishWeightKg, value) }
      : row));
  }

  function updateFishWeight(i: number, value: string) {
    const row = formRows[i];
    updateRow(i, {
      fishWeightKg: value,
      fishPrice: fishTotalPrice(value, row?.fishPricePerKg ?? ""),
    });
  }

  function updateBulkPortionOption(card: AdjustmentCard, portionIndex: number, weightInput: string) {
    if (!card.groupId) return;
    setFormRows((rows) => rows.map((row) => row.selectionGroupId === card.groupId
      ? {
          ...row,
          bulkPortionOptions: row.bulkPortionOptions.map((option, index) =>
            index === portionIndex ? { weightInput } : option,
          ),
        }
      : row));
  }

  function addBulkPortionOption(card: AdjustmentCard) {
    if (!card.groupId) return;
    setFormRows((rows) => rows.map((row) => row.selectionGroupId === card.groupId
      ? {
          ...row,
          bulkPortionOptions: [...row.bulkPortionOptions, { weightInput: "" }],
        }
      : row));
  }

  function removeBulkPortionOption(card: AdjustmentCard, portionIndex: number) {
    if (!card.groupId) return;
    setFormRows((rows) => rows.map((row) => row.selectionGroupId === card.groupId
      ? { ...row, bulkPortionOptions: row.bulkPortionOptions.filter((_, index) => index !== portionIndex) }
      : row));
  }

  function fishConfigChanged(row: FormRow): boolean {
    const product = products.find((item) => item.id === row.productId);
    if (!product) return false;
    const savedMode = getFishInventoryMode(product);
    const savedRate = getFishPricePerKg(product);
    const savedOptions = bulkPortionOptionsForSave(bulkPortionOptionsForProduct(product))
      .map((option) => ({
        weightKg: Number(option.weightKg.toFixed(3)),
        ...(option.minWeightKg != null && option.maxWeightKg != null
          ? { minWeightKg: option.minWeightKg, maxWeightKg: option.maxWeightKg }
          : {}),
      }));
    const editedOptions = bulkPortionOptionsForSave(row.bulkPortionOptions)
      .filter((option) => Number.isFinite(option.weightKg) && option.weightKg > 0)
      .map((option) => ({
        weightKg: Number(option.weightKg.toFixed(3)),
        ...(option.minWeightKg != null && option.maxWeightKg != null
          ? { minWeightKg: option.minWeightKg, maxWeightKg: option.maxWeightKg }
          : {}),
      }));
    return row.fishInventoryMode !== savedMode ||
      (row.fishInventoryMode !== "standard" &&
        (Number(row.fishPricePerKg) !== Number(savedRate) || JSON.stringify(editedOptions) !== JSON.stringify(savedOptions)));
  }

  function selectProduct(i: number, group: ProductGroup) {
    const currentProduct = products.find((product) => product.id === formRows[i]?.productId);
    if (currentProduct && getProductGroupId(currentProduct) === group.id) return;

    const mode = formRows[i]?.mode ?? "add";
    const fishInventoryMode = group.fishInventoryMode;
    const productsToSelect = fishInventoryMode === "standard" ? group.products : group.products.slice(0, 1);
    const selectedRows = productsToSelect.map((product) => {
      const displayLabel = formatVariantLabelWithUnit(product.variantLabel, product.unit);
      const displayName = fishInventoryMode === "standard" && product.variantLabel ? `${product.name} (${displayLabel})` : product.name;
      // Keep batch sequencing and inventory attached to each variant's own product record.
      const productBatches: Batch[] = product.batches ?? [];
      const autoNum = generateNextBatchNumber(displayName, productBatches, product.shortCode);
      const rate = getFishPricePerKg(product);
      return {
        ...emptyRow(),
        productId: product.id,
        selectionGroupId: group.id,
        productName: displayName,
        category: product.category || "",
        unit: fishInventoryMode === "whole_fish" ? "per piece"
          : fishInventoryMode === "bulk_portions" ? "kg"
          : normalizeProductUnit(product.unit),
        price: String(product.price ?? 0),
        quantityBefore: product.quantity,
        mode,
        addQuantity: fishInventoryMode === "whole_fish" ? "1" : "",
        isWholeFishBatch: fishInventoryMode === "whole_fish",
        isBulkFishBatch: fishInventoryMode === "bulk_portions",
        fishInventoryMode,
        fishPricePerKg: rate == null ? "" : String(rate),
        bulkPortionOptions: fishInventoryMode === "bulk_portions"
          ? bulkPortionOptionsForProduct(product)
          : [],
        search: group.name,
        batchNumber: mode === "add" ? autoNum : "",
      };
    });

    setFormRows((rows) => {
      const oldGroupId = rows[i]?.selectionGroupId;
      const insertionIndex = rows.slice(0, i).filter((row) => row.selectionGroupId !== oldGroupId || !oldGroupId).length;
      const remaining = rows.filter((row, index) => oldGroupId
        ? row.selectionGroupId !== oldGroupId
        : index !== i);
      return [
        ...remaining.slice(0, insertionIndex),
        ...selectedRows,
        ...remaining.slice(insertionIndex),
      ];
    });
  }

  function setProductFishMode(card: AdjustmentCard, mode: FishInventoryMode) {
    if (!card.groupId) return;
    const group = groupProducts(products).find((candidate) => candidate.id === card.groupId);
    if (!group) return;
    const currentRows = formRows.filter((row) => row.selectionGroupId === card.groupId);
    const currentFormMode = currentRows[0]?.fishInventoryMode ?? group.fishInventoryMode;
    if (currentFormMode === mode) return;

    if (currentRows.some((row) =>
      (row.isWholeFishBatch
        ? row.fishWeightKg.trim() || row.fishPrice.trim()
        : Number(row.addQuantity) > 0 || Number(row.removeQuantity) > 0)
    )) {
      toast({ title: "Save or clear the current entries before changing batch mode", variant: "destructive" });
      return;
    }
    const hasStoredStock = group.products.some((product) => Number(product.quantity) > 0);
    if (hasStoredStock) {
      toast({
        title: "Current stock uses another inventory mode",
        description: "Sell or remove the current stock before switching modes.",
        variant: "destructive",
      });
      return;
    }

    const root = group.products.find((product) => product.id === group.id) ?? group.products[0];
    if (!root) return;
    const rootBatches = root.batches ?? [];
    const productsToSelect = mode === "standard"
      ? products.filter((product) => getProductGroupId(product) === group.id)
      : [root];
    const replacement = productsToSelect.map((product) => {
      const rate = getFishPricePerKg(product);
      const displayName = mode === "standard" && product.variantLabel
        ? `${product.name} (${formatVariantLabelWithUnit(product.variantLabel, product.unit)})`
        : product.name;
      return {
        ...emptyRow(),
        productId: product.id,
        selectionGroupId: group.id,
        productName: displayName,
        category: product.category || "",
        unit: mode === "whole_fish" ? "per piece" : mode === "bulk_portions" ? "kg" : normalizeProductUnit(product.unit),
        price: String(product.price ?? 0),
        quantityBefore: product.quantity,
        mode: "add" as FormMode,
        addQuantity: mode === "whole_fish" ? "1" : "",
        isWholeFishBatch: mode === "whole_fish",
        isBulkFishBatch: mode === "bulk_portions",
        fishInventoryMode: mode,
        fishPricePerKg: rate == null ? "" : String(rate),
        bulkPortionOptions: mode === "bulk_portions"
          ? bulkPortionOptionsForProduct(product)
          : [],
        search: group.name,
        batchNumber: generateNextBatchNumber(displayName, product.batches ?? rootBatches, product.shortCode),
      };
    });
    setFormRows((rows) => {
      const firstIndex = rows.findIndex((row) => row.selectionGroupId === card.groupId);
      const remaining = rows.filter((row) => row.selectionGroupId !== card.groupId);
      return [...remaining.slice(0, firstIndex), ...replacement, ...remaining.slice(firstIndex)];
    });
  }

  function addFishEntry(card: AdjustmentCard) {
    const firstRow = card.rows[0]?.row;
    if (!firstRow?.isWholeFishBatch) return;
    const product = products.find((item) => item.id === firstRow.productId);
    if (!product) return;
    const draftedBatches = card.rows.map(({ row }) => ({
      batchNumber: row.batchNumber,
      quantity: 0,
      shelfLifeDays: null,
      receivedDate: null,
      expiryDate: null,
    }));
    const batchNumber = generateNextBatchNumber(
      product.name,
      [...(product.batches ?? []), ...draftedBatches],
      product.shortCode,
    );
    const newRow: FormRow = {
      ...firstRow,
      mode: "add",
      addQuantity: "1",
      shelfLifeDays: "",
      expiryDate: "",
      expiryTime: getCurrentTime12h(),
      batchNumber,
      fishWeightKg: "",
      fishPrice: "",
      removeQuantity: "",
      selectedBatchId: "",
    };
    setFormRows((rows) => {
      const lastIndex = rows.reduce((last, row, index) => row.selectionGroupId === card.groupId ? index : last, -1);
      return [...rows.slice(0, lastIndex + 1), newRow, ...rows.slice(lastIndex + 1)];
    });
  }

  function removeFishEntry(card: AdjustmentCard, rowIndex: number) {
    if (card.rows.length <= 1) return;
    setFormRows((rows) => rows.filter((_, index) => index !== rowIndex));
  }

  function clearProduct(i: number) {
    const currentGroupId = formRows[i]?.selectionGroupId;
    setFormRows((rows) => {
      const insertionIndex = rows.slice(0, i).filter((row) => row.selectionGroupId !== currentGroupId || !currentGroupId).length;
      const remaining = rows.filter((row, index) => currentGroupId
        ? row.selectionGroupId !== currentGroupId
        : index !== i);
      return [
        ...remaining.slice(0, insertionIndex),
        emptyRow(),
        ...remaining.slice(insertionIndex),
      ];
    });
    setExpandedBatchProductId("");
  }

  function onSearchChange(i: number, val: string) {
    const currentGroupId = formRows[i]?.selectionGroupId;
    if (!currentGroupId) {
      updateRow(i, { search: val, productId: "", productName: "", category: "", unit: "", price: "", quantityBefore: 0, batchNumber: "", selectedBatchId: "" });
      return;
    }
    setFormRows((rows) => {
      const insertionIndex = rows.slice(0, i).filter((row) => row.selectionGroupId !== currentGroupId).length;
      const remaining = rows.filter((row) => row.selectionGroupId !== currentGroupId);
      return [
        ...remaining.slice(0, insertionIndex),
        { ...emptyRow(), search: val },
        ...remaining.slice(insertionIndex),
      ];
    });
    setExpandedBatchProductId("");
  }

  function removeProductCard(card: AdjustmentCard) {
    setFormRows((rows) => {
      const remaining = card.groupId
        ? rows.filter((row) => row.selectionGroupId !== card.groupId)
        : rows.filter((_, index) => index !== card.rows[0]?.idx);
      return remaining.length ? remaining : [emptyRow()];
    });
    const removedIds = new Set(card.rows.map(({ row }) => row.productId).filter(Boolean));
    if (removedIds.has(expandedBatchProductId)) setExpandedBatchProductId("");
  }

  function changeMode(i: number, mode: FormMode) {
    const row = formRows[i];
    let batchNumber = "";
    if (mode === "add" && row.productId) {
      // Only use this product's own batches for per-product sequential counter.
      const prod = products.find((p) => p.id === row.productId);
      const productBatches: Batch[] = prod?.batches ?? [];
      batchNumber = generateNextBatchNumber(row.productName, productBatches, prod?.shortCode);
    }
    updateRow(i, { mode, batchNumber, selectedBatchId: "" });
  }

  function setShelfLife(i: number, val: string) {
    const days = Number(val);
    const expiry = val !== "" && Number.isFinite(days) ? addDaysISO(days, formDate) : "";
    updateRow(i, { shelfLifeDays: val, expiryDate: expiry });
  }

  function setExpiryDate(i: number, val: string) {
    const days = calculateShelfLifeDays(formDate, val);
    const shelfLifeDays = days == null ? "" : String(days);
    updateRow(i, { expiryDate: val, shelfLifeDays });
  }

  async function saveProductPrice(i: number) {
    const row = formRows[i];
    if (!row?.productId || !selectedSubHubId) return;
    if (row.price.trim() === "") {
      toast({ title: "Enter a price", variant: "destructive" });
      return;
    }
    const price = Number(row.price);
    if (!Number.isFinite(price) || price < 0) {
      toast({ title: "Enter a valid non-negative price", variant: "destructive" });
      return;
    }
    const currentPrice = Number(products.find((p) => p.id === row.productId)?.price ?? 0);
    if (price === currentPrice) return;

    setSavingPriceProductId(row.productId);
    try {
      await apiFetch(`/api/sub-hubs/${selectedSubHubId}/menu/products/${row.productId}`, {
        method: "PUT",
        body: JSON.stringify({ price }),
      });
      setProducts((current) => current.map((product) =>
        product.id === row.productId ? { ...product, price } : product
      ));
      toast({ title: "Product price updated", description: `${row.productName} is now ₹${price.toFixed(2)}.` });
    } catch (err: any) {
      toast({ title: "Failed to update price", description: err.message, variant: "destructive" });
    } finally {
      setSavingPriceProductId("");
    }
  }

  function resetForm() {
    setFormDate(toInputDate(new Date()));
    setFormReason("");
    setFormRows([emptyRow()]);
  }

  async function handleSave() {
    const hasStockChange = (row: FormRow) => row.isWholeFishBatch
      ? row.mode === "add" && Number(row.fishWeightKg) > 0 && Number(row.fishPricePerKg) > 0
      : (row.mode === "add" && row.addQuantity !== "" && Number(row.addQuantity) > 0) ||
        (row.mode === "add_existing" && row.selectedBatchId && row.addQuantity !== "" && Number(row.addQuantity) > 0) ||
        (row.mode === "remove" && row.removeQuantity !== "" && Number(row.removeQuantity) > 0);
    const firstRowForGroup = (row: FormRow, index: number) => !row.selectionGroupId ||
      formRows.findIndex((candidate) => candidate.selectionGroupId === row.selectionGroupId) === index;
    const validRows = formRows.filter((row, index) =>
      row.productId && (
        hasStockChange(row) ||
        (firstRowForGroup(row, index) && fishConfigChanged(row))
      )
    );
    if (validRows.length === 0) {
      toast({ title: "Add stock or change the fish pricing setup", variant: "destructive" });
      return;
    }
    if (!formReason.trim()) { toast({ title: "Reason is required", variant: "destructive" }); return; }
    const incompleteFishEntry = formRows.find((row) =>
      row.isWholeFishBatch && row.productId &&
      row.fishWeightKg.trim() !== "" &&
      (!Number.isFinite(Number(row.fishWeightKg)) || Number(row.fishWeightKg) <= 0 ||
        !Number.isFinite(Number(row.fishPricePerKg)) || Number(row.fishPricePerKg) <= 0)
    );
    if (incompleteFishEntry) {
      toast({ title: "Enter a valid weight and selling price per kg", variant: "destructive" });
      return;
    }
    const invalidFishSetup = validRows.find((row) => {
      if (row.fishInventoryMode === "standard") return false;
      const rate = Number(row.fishPricePerKg);
      if (!Number.isFinite(rate) || rate <= 0) return true;
      if (row.fishInventoryMode !== "bulk_portions") return false;
      const options = bulkPortionOptionsForSave(row.bulkPortionOptions);
      return options.length === 0 ||
        options.some((option) => {
          const hasRange = option.minWeightKg != null || option.maxWeightKg != null;
          if (hasRange) {
            return !Number.isFinite(option.minWeightKg) || Number(option.minWeightKg) <= 0 ||
              !Number.isFinite(option.maxWeightKg) || Number(option.maxWeightKg) <= Number(option.minWeightKg) ||
              !Number.isFinite(option.weightKg) || option.weightKg <= 0;
          }
          return !Number.isFinite(option.weightKg) || option.weightKg <= 0;
        }) ||
        new Set(options.map((option) => Math.round(option.weightKg * 1000))).size !== options.length;
    });
    if (invalidFishSetup) {
      toast({
        title: invalidFishSetup.fishInventoryMode === "bulk_portions" ? "Check the kg rate and portion sizes" : "Enter a valid selling price per kg",
        description: invalidFishSetup.fishInventoryMode === "bulk_portions"
          ? "Enter one kg weight (0.5) or a valid range (0.5-0.6) for each option. Average weights must be unique."
          : "A positive per-kg rate is needed to calculate each fish price.",
        variant: "destructive",
      });
      return;
    }
    const missingExpiry = validRows.find((r) => r.mode === "add" && !r.shelfLifeDays && !r.expiryDate);
    if (missingExpiry) {
      toast({ title: "Set shelf life or expiry", description: `Add shelf life (days) or an expiry date for ${missingExpiry.productName}.`, variant: "destructive" });
      return;
    }
    const missingBatch = validRows.find((r) => r.mode === "add_existing" && !r.selectedBatchId);
    if (missingBatch) {
      toast({ title: "Select a batch", description: `Choose which existing batch to add into for ${missingBatch.productName}.`, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify({
          subHubId: selectedSubHubId,
          superHubId: selectedSuperHubId,
          date: formDate,
          reason: formReason,
          items: validRows.map((r) => {
            const configChanged = fishConfigChanged(r);
            const fishConfig = r.fishInventoryMode !== "standard" || configChanged
              ? {
                  fishInventoryMode: r.fishInventoryMode,
                  ...(r.fishInventoryMode !== "standard" ? {
                    fishPricePerKg: Number(r.fishPricePerKg),
                    repriceExistingFish: r.fishInventoryMode === "whole_fish" &&
                      Number(r.fishPricePerKg) !== Number(getFishPricePerKg(products.find((product) => product.id === r.productId))),
                  } : {}),
                  ...(r.fishInventoryMode === "bulk_portions" ? {
                    bulkPortionOptions: bulkPortionOptionsForSave(r.bulkPortionOptions),
                    bulkPortionWeightsKg: bulkPortionOptionsForSave(r.bulkPortionOptions)
                      .map((option) => option.weightKg),
                  } : {}),
                }
              : {};
            if (!hasStockChange(r)) {
              return { productId: r.productId, mode: "configure", ...fishConfig };
            }
            if (r.isWholeFishBatch) return {
              productId: r.productId,
              mode: "add",
              ...fishConfig,
              addQuantity: 1,
              fishWeightKg: Number(r.fishWeightKg),
              fishPrice: Number(r.fishPrice),
              fishPricePerKg: Number(r.fishPricePerKg),
              receivedDate: formDate,
              shelfLifeDays: r.shelfLifeDays !== ""
                ? Number(r.shelfLifeDays)
                : (calculateShelfLifeDays(formDate, r.expiryDate) ?? undefined),
              expiryDate: r.expiryDate
                ? (r.expiryTime ? `${r.expiryDate}T${to24hTime(r.expiryTime)}:00+05:30` : r.expiryDate)
                : undefined,
              batchNumber: r.batchNumber || undefined,
            };
            if (r.mode === "add") return {
              productId: r.productId, mode: "add",
              ...fishConfig,
              addQuantity: Number(r.addQuantity),
              shelfLifeDays: r.shelfLifeDays !== "" ? Number(r.shelfLifeDays) : undefined,
              expiryDate: r.expiryDate
                ? (r.expiryTime ? `${r.expiryDate}T${to24hTime(r.expiryTime)}:00+05:30` : r.expiryDate)
                : undefined,
              batchNumber: r.batchNumber || undefined,
            };
            if (r.mode === "add_existing") return {
              productId: r.productId, mode: "add_existing",
              ...fishConfig,
              batchId: r.selectedBatchId,
              addQuantity: Number(r.addQuantity),
            };
            return {
              productId: r.productId, mode: "remove",
              ...fishConfig,
              removeQuantity: Number(r.removeQuantity),
              batchId: r.selectedBatchId || undefined,
            };
          }),
        }),
      });
      toast({ title: "Stock adjustment saved" });
      resetForm();
      reload();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const usedGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of formRows) {
      if (!row.productId) continue;
      const product = products.find((item) => item.id === row.productId);
      ids.add(product ? getProductGroupId(product) : row.productId);
    }
    return ids;
  }, [formRows, products]);

  const adjustmentCards = useMemo(() => {
    const cards: AdjustmentCard[] = [];
    formRows.forEach((row, idx) => {
      const product = products.find((item) => item.id === row.productId);
      const groupId = row.selectionGroupId || (product ? getProductGroupId(product) : undefined);
      const previous = cards[cards.length - 1];
      if (groupId && previous?.groupId === groupId) {
        previous.rows.push({ row, idx });
      } else {
        cards.push({
          key: groupId || `empty-${idx}`,
          groupId,
          rows: [{ row, idx }],
        });
      }
    });
    return cards;
  }, [formRows, products]);

  const headerSlot = document.getElementById("page-header-slot");
  const headerContent = (
    <div className="flex items-center justify-between w-full gap-4 min-w-0">
      <div className="min-w-0 flex-shrink-0">
        <p className="text-sm font-bold text-[#162B4D] leading-tight">Inventory Stock Management</p>
        <p className="text-[11px] text-gray-400 leading-tight hidden sm:block">Adjust product stock and manage each incoming fish as a batch.</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {selectedSuperHub && <LockedHubBadge label="Super Hub" name={selectedSuperHub.name} location={selectedSuperHub.location} />}
        {selectedSuperHub && selectedSubHub && <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
        {selectedSubHub && <LockedHubBadge label="Sub Hub" name={selectedSubHub.name} location={selectedSubHub.location} />}
        <div className="hidden">
          <Select value={selectedSuperHubId} onValueChange={setSelectedSuperHubId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{superHubs.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={selectedSubHubId} onValueChange={setSelectedSubHubId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{subHubs.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  // ─── FORM VIEW ───────────────────────────────────────────────────────────────
  return (
    <>
      {headerSlot && createPortal(headerContent, headerSlot)}
      <div className="space-y-6">
        {/* Header meta row */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-6">
          <div>
            <h2 className="text-base font-bold text-[#162B4D] mb-4">Adjustment Details</h2>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Date</Label>
                <Input
                  type="date"
                  value={formDate}
                  onChange={(e) => {
                    const date = e.target.value;
                    setFormDate(date);
                    setFormRows((rows) => rows.map((row) => {
                      if (row.mode !== "add" || !row.expiryDate) return row;
                      const days = calculateShelfLifeDays(date, row.expiryDate);
                      return { ...row, shelfLifeDays: days == null ? "" : String(days) };
                    }));
                  }}
                  className="h-9 text-sm font-medium text-[#162B4D]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                  Reason <span className="text-red-500">*</span>
                </Label>
                <Input
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  placeholder="Enter reason"
                  className="h-9 text-sm font-medium text-[#162B4D]"
                  list="inv-reason-list"
                />
                <datalist id="inv-reason-list">{REASONS.map((r) => <option key={r} value={r} />)}</datalist>
              </div>
            </div>
          </div>

          <div>
          {/* Products section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-[#162B4D]">Products</h2>
              <span className="text-[11px] text-gray-400 font-medium">
                {adjustmentCards.filter((card) => card.groupId).length} / {adjustmentCards.length} selected
              </span>
            </div>

            <div className="space-y-3">
              {adjustmentCards.map((card) => {
                const firstEntry = card.rows[0];
                const firstRow = firstEntry.row;
                const group = card.groupId
                  ? groupProducts(products).find((candidate) => candidate.id === card.groupId)
                  : undefined;
                const hasStoredStock = group?.products.some((product) => Number(product.quantity) > 0) ?? false;

                if (!firstRow.productId) {
                  return (
                    <div key={card.key} className="rounded-xl border border-gray-300 bg-white p-3">
                      <div className="flex items-end justify-between gap-3">
                        <div className="w-full max-w-md space-y-1.5">
                          <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Product</Label>
                          <ProductSelector
                            row={firstRow} idx={firstEntry.idx} allProducts={products} usedGroupIds={usedGroupIds}
                            onSelect={selectProduct} onClear={clearProduct} onSearchChange={onSearchChange}
                          />
                        </div>
                        {adjustmentCards.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeProductCard(card)}
                            aria-label="Remove product selection"
                            className="rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-gray-400">Choose a product, then track it as individual fish or bulk stock by kg.</p>
                    </div>
                  );
                }

                const totalQuantity = firstRow.isWholeFishBatch || firstRow.isBulkFishBatch
                  ? firstRow.quantityBefore
                  : card.rows.reduce((total, entry) => total + entry.row.quantityBefore, 0);
                const cardProduct = products.find((product) => product.id === firstRow.productId);
                return (
                  <div key={card.key} className="overflow-hidden rounded-xl border border-gray-300 bg-white">
                    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 bg-gray-50/70 p-3">
                      <div className="w-full max-w-md space-y-1.5">
                        <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Product</Label>
                        <ProductSelector
                          row={firstRow} idx={firstEntry.idx} allProducts={products} usedGroupIds={usedGroupIds}
                          onSelect={selectProduct} onClear={clearProduct} onSearchChange={onSearchChange}
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        {group && (
                          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
                            {([
                              ["whole_fish", "Individual fish"],
                              ["bulk_portions", "Bulk by kg"],
                            ] as const).map(([mode, label]) => {
                              const active = firstRow.fishInventoryMode === mode;
                              const blockedByStock = group.fishInventoryMode !== mode && hasStoredStock;
                              return (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => setProductFishMode(card, mode)}
                                  disabled={active || blockedByStock}
                                  title={blockedByStock ? "Sell or remove current stock before changing modes" : undefined}
                                  className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed ${
                                    active ? "bg-[#364F9F] text-white" : "text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div className="text-right">
                          <p className="text-xs font-bold text-[#162B4D]">
                            {firstRow.isWholeFishBatch
                              ? `${card.rows.length} ${card.rows.length === 1 ? "fish entry" : "fish entries"}`
                              : firstRow.isBulkFishBatch
                                ? `${card.rows.length} stock batch${card.rows.length === 1 ? "" : "es"}`
                              : `${card.rows.length} ${card.rows.length === 1 ? "variant" : "variants"}`}
                          </p>
                          <p className="text-[10px] text-gray-500">
                            {totalQuantity} {firstRow.isWholeFishBatch ? "fish" : firstRow.isBulkFishBatch ? "kg available" : `${firstRow.unit} available across variants`}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeProductCard(card)}
                          aria-label={`Remove ${group?.name || firstRow.productName}`}
                          title="Remove product and its variants"
                          className="rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {firstRow.fishInventoryMode === "standard" && !hasStoredStock ? (
                      <div className="flex min-h-20 items-center justify-center px-4 text-center text-xs text-gray-500">
                        Select <span className="mx-1 font-semibold text-[#162B4D]">Individual fish</span> or
                        <span className="mx-1 font-semibold text-[#162B4D]">Bulk by kg</span> before adding stock.
                      </div>
                    ) : firstRow.isWholeFishBatch ? (
                      <WholeFishAdjustmentTable
                        rows={card.rows}
                        product={cardProduct}
                        subHubId={selectedSubHubId}
                        onUpdate={updateRow}
                        onAdd={() => addFishEntry(card)}
                        onRemove={(idx) => removeFishEntry(card, idx)}
                        onReload={reload}
                        onRateChange={(value) => updateFishPricePerKg(card, value)}
                        onWeightChange={updateFishWeight}
                      />
                    ) : (
                    <div className="overflow-x-auto">
                      {firstRow.isBulkFishBatch && (
                        <div className="border-b border-gray-200 bg-[#364F9F]/[0.025] p-3">
                          <div className="space-y-3">
                            <div className="grid gap-3 md:max-w-[460px] md:grid-cols-2">
                            <div className="w-56 space-y-1.5">
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                {firstRow.mode === "remove" ? "Weight to remove (kg)" : "Incoming stock (kg)"}
                              </Label>
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                inputMode="decimal"
                                value={firstRow.mode === "remove" ? firstRow.removeQuantity : firstRow.addQuantity}
                                onChange={(event) => updateRow(
                                  firstEntry.idx,
                                  firstRow.mode === "remove"
                                    ? { removeQuantity: event.target.value }
                                    : { addQuantity: event.target.value },
                                )}
                                placeholder="e.g. 20"
                                aria-label={firstRow.mode === "remove" ? "Kilograms to remove" : "Stock weight in kilograms"}
                                className="h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm font-semibold text-[#162B4D] outline-none focus:border-[#364F9F] focus:ring-2 focus:ring-[#364F9F]/15"
                              />
                              <p className="text-[10px] text-gray-500">
                                Current on hand: {Number(firstRow.quantityBefore || 0).toFixed(3)} kg
                              </p>
                            </div>
                            <div className="w-56 space-y-1.5">
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Selling price per kg</Label>
                              <div className="flex items-center gap-1">
                                <span className="text-sm text-gray-400">₹</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  inputMode="decimal"
                                  value={firstRow.fishPricePerKg}
                                  onChange={(event) => updateFishPricePerKg(card, event.target.value)}
                                  placeholder="e.g. 600"
                                  aria-label="Customer selling price per kilogram"
                                  className="h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm font-semibold text-[#162B4D] outline-none focus:border-[#364F9F] focus:ring-2 focus:ring-[#364F9F]/15"
                                />
                              </div>
                            </div>
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Sale pack options</Label>
                              <div className="flex w-full items-center gap-2 overflow-x-auto pb-1">
                                {firstRow.bulkPortionOptions.map((option, portionIndex) => {
                                  const parsedOption = parseBulkPortionInput(option.weightInput);
                                  const isRange = parsedOption?.minWeightKg != null && parsedOption?.maxWeightKg != null;
                                  const averageWeightKg = parsedOption?.weightKg ?? Number.NaN;
                                  const calculatedPrice = bulkPortionPrice(averageWeightKg, firstRow.fishPricePerKg);
                                  return (
                                    <div
                                      key={`bulk-portion-${portionIndex}`}
                                      title={`Pack ${portionIndex + 1}`}
                                      className={`flex h-12 shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 ${
                                        isRange ? "min-w-[365px]" : "min-w-[300px]"
                                      }`}
                                    >
                                      <span className="shrink-0 text-[10px] font-semibold text-gray-500">#{portionIndex + 1}</span>
                                      <input
                                        type="text"
                                        value={option.weightInput}
                                        onChange={(event) => updateBulkPortionOption(card, portionIndex, event.target.value)}
                                        aria-label={`Pack ${portionIndex + 1} weight in kilograms or range`}
                                        data-testid={`input-pack-weight-${firstRow.productId}-${portionIndex + 1}`}
                                        placeholder="0.5 or 0.5-0.6"
                                        title="Enter an exact weight in kg or a minimum-maximum range in kg"
                                        className="h-8 w-[124px] shrink-0 rounded-md border border-gray-200 px-2 text-xs font-semibold text-[#162B4D] outline-none focus:border-[#364F9F]"
                                      />
                                      <span className="shrink-0 whitespace-nowrap text-[10px] text-gray-500">
                                        {bulkPortionDisplayLabel(option)}
                                      </span>
                                      {isRange && (
                                        <span className="shrink-0 whitespace-nowrap text-[9px] text-gray-500">
                                          avg {bulkPortionLabel(averageWeightKg)}
                                        </span>
                                      )}
                                      <span className="ml-auto whitespace-nowrap text-[11px] font-bold text-[#162B4D]">
                                        {calculatedPrice ? `₹${calculatedPrice}` : "Set rate"}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => removeBulkPortionOption(card, portionIndex)}
                                        aria-label={`Remove pack size ${portionIndex + 1}`}
                                        title="Remove pack size"
                                        data-testid={`button-remove-pack-${firstRow.productId}-${portionIndex + 1}`}
                                        className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  );
                                })}
                                <button
                                  type="button"
                                  onClick={() => addBulkPortionOption(card)}
                                  data-testid={`button-add-bulk-pack-${firstRow.productId}`}
                                  className="flex h-12 shrink-0 items-center justify-center gap-1 rounded-md border border-dashed border-[#364F9F]/35 bg-white px-3 text-xs font-semibold text-[#364F9F] hover:bg-[#364F9F]/5"
                                >
                                  <Plus className="h-3.5 w-3.5" /> Add pack
                                </button>
                              </div>
                              <p className="text-[10px] text-gray-500">
                                Enter kg directly: 0.5 = 500 g; use 0.5-0.6 or 0.5-0.550 for a range. Range price and stock use the average weight.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                      <table className={`w-full ${firstRow.isBulkFishBatch ? "min-w-[1220px]" : "min-w-[1430px]"} table-fixed border-collapse text-left`}>
                        <colgroup>
                          {firstRow.isBulkFishBatch ? (
                            <>
                              <col style={{ width: 190 }} />
                              <col style={{ width: 165 }} />
                              <col style={{ width: 130 }} />
                              <col style={{ width: 280 }} />
                              <col style={{ width: 300 }} />
                              <col style={{ width: 155 }} />
                            </>
                          ) : (
                            <>
                              <col style={{ width: 145 }} />
                              <col style={{ width: 170 }} />
                              <col style={{ width: 155 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 130 }} />
                              <col style={{ width: 265 }} />
                              <col style={{ width: 300 }} />
                              <col style={{ width: 155 }} />
                            </>
                          )}
                        </colgroup>
                        <thead className="bg-white">
                          <tr>
                            {(firstRow.isBulkFishBatch
                              ? ["Product", "Mode", "Shelf Life (days)", "Expiry Date & Time", "Batch / Selection", "Batch Info"]
                              : ["Weight / Variant", "Price", "Mode", "Quantity", "Shelf Life (days)", "Expiry Date & Time", "Batch / Selection", "Batch Info"]
                            ).map((heading) => (
                              <th key={heading} className="border-b border-r border-gray-200 px-2.5 py-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap last:border-r-0">
                                {heading}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {card.rows.map(({ row, idx }) => {
                            const isAdd = row.mode === "add";
                            const isAddExisting = row.mode === "add_existing";
                            const isAddAny = isAdd || isAddExisting;
                            const dLeft = isAdd ? daysUntil(row.expiryDate) : null;
                            const expTone = dLeft == null ? "text-gray-400"
                              : dLeft < 0 ? "text-red-600"
                              : dLeft <= 7 ? "text-amber-600"
                              : "text-emerald-600";
                            const product = products.find((item) => item.id === row.productId);
                            const productBatches: Batch[] = product?.batches ?? [];
                            const activeBatches = productBatches.filter((batch) => {
                              if (batch.quantity <= 0) return false;
                              if (batch.expiryDate) {
                                const expiry = new Date(batch.expiryDate);
                                if (!isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) return false;
                              }
                              return true;
                            });
                            const priceNumber = row.price.trim() === "" ? NaN : Number(row.price);
                            const hasPriceChange = Number.isFinite(priceNumber) &&
                              priceNumber >= 0 &&
                              priceNumber !== Number(product?.price ?? 0);
                            const batchesOpen = expandedBatchProductId === row.productId;
                            const variantName = row.fishInventoryMode === "standard"
                              ? formatVariantLabelWithUnit(product?.variantLabel, product?.unit ?? row.unit)
                              : product?.name ?? row.productName;

                            return (
                              <Fragment key={row.productId || idx}>
                                <tr className="hover:bg-gray-50/70">
                                  <td className="border-b border-r border-gray-200 px-2.5 py-2 align-middle">
                                    <p className="text-sm font-semibold text-[#162B4D]">{variantName}</p>
                                    <p className="mt-0.5 text-[10px] text-gray-400">{getProductUnitSuffix(row.unit)} · {row.quantityBefore} available</p>
                                  </td>
                                  {!firstRow.isBulkFishBatch && (
                                    <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                    <div className="flex items-center gap-1">
                                      <span className="shrink-0 text-xs text-gray-400">₹</span>
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        inputMode="decimal"
                                        aria-label={`Price for ${row.productName || "selected product"}`}
                                        value={row.price}
                                        onChange={(event) => updateRow(idx, { price: event.target.value })}
                                        placeholder="0.00"
                                        className="min-w-0 w-[92px] h-8 px-1.5 text-sm font-semibold text-[#162B4D] border border-gray-200 rounded-md outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => saveProductPrice(idx)}
                                        disabled={!hasPriceChange || Boolean(savingPriceProductId)}
                                        aria-label={`Save price for ${row.productName}`}
                                        title={hasPriceChange ? "Save price" : "Price is current"}
                                        className="shrink-0 rounded-md border border-gray-200 px-1.5 py-1 text-[10px] font-semibold text-[#364F9F] hover:bg-[#364F9F]/5 disabled:cursor-not-allowed disabled:text-gray-400"
                                      >
                                        {savingPriceProductId === row.productId ? "Saving…" : hasPriceChange ? "Save" : "Saved"}
                                      </button>
                                    </div>
                                    </td>
                                  )}
                                  <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                    <Select value={row.mode} onValueChange={(value) => changeMode(idx, value as FormMode)}>
                                      <SelectTrigger className="h-9 text-xs font-semibold"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="add"><span className="font-semibold text-emerald-700">+ New Batch</span></SelectItem>
                                        <SelectItem value="add_existing"><span className="font-semibold text-[#364F9F]">+ Add to Batch</span></SelectItem>
                                        <SelectItem value="remove"><span className="font-semibold text-red-700">– Reduce</span></SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </td>
                                  {!firstRow.isBulkFishBatch && (
                                    <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                      <input
                                        type="number"
                                        min="0"
                                        value={isAddAny ? row.addQuantity : row.removeQuantity}
                                        onChange={(event) => updateRow(idx, isAddAny ? { addQuantity: event.target.value } : { removeQuantity: event.target.value })}
                                        placeholder="0"
                                        aria-label={`Quantity for ${row.productName || "selected product"}`}
                                        className="w-full h-9 px-2 text-sm font-bold text-[#162B4D] text-center border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]"
                                      />
                                    </td>
                                  )}
                                  <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                    {isAdd ? (
                                      <input
                                        type="number"
                                        min="0"
                                        value={row.shelfLifeDays}
                                        onChange={(event) => setShelfLife(idx, event.target.value)}
                                        placeholder="e.g. 7"
                                        aria-label={`Shelf life in days for ${row.productName || "selected product"}`}
                                        className="w-full h-9 px-2 text-sm font-medium text-center border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F]"
                                      />
                                    ) : <span className="text-xs text-gray-300">—</span>}
                                  </td>
                                  <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                    {isAdd ? (
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="date"
                                          value={row.expiryDate}
                                          onChange={(event) => setExpiryDate(idx, event.target.value)}
                                          aria-label={`Expiry date for ${row.productName || "selected product"}`}
                                          className={`min-w-0 flex-1 h-8 px-1.5 text-[11px] font-semibold border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F] ${expTone}`}
                                        />
                                        <div className="w-[112px] shrink-0">
                                          <ClockPickerField value={row.expiryTime} onChange={(value) => updateRow(idx, { expiryTime: value })} />
                                        </div>
                                        {dLeft != null && <p className={`text-[10px] font-bold ${expTone}`}>{dLeft < 0 ? `Expired ${Math.abs(dLeft)}d ago` : dLeft === 0 ? "Expires today" : `${dLeft}d left`}</p>}
                                      </div>
                                    ) : <span className="text-xs text-gray-300">—</span>}
                                  </td>
                                  <td className="border-b border-r border-gray-200 px-2 py-2 align-middle">
                                    {isAdd ? (
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="text"
                                          value={row.batchNumber}
                                          onChange={(event) => updateRow(idx, { batchNumber: event.target.value.toUpperCase() })}
                                          placeholder="Batch ID"
                                          aria-label={`Batch ID for ${row.productName}`}
                                          title="Auto-generated and editable"
                                          className="min-w-0 w-full h-8 px-2 text-[11px] font-bold text-[#364F9F] border border-[#364F9F]/30 bg-[#364F9F]/5 rounded-lg outline-none focus:ring-2 focus:ring-[#364F9F]/20 focus:border-[#364F9F] uppercase tracking-wider"
                                        />
                                      </div>
                                    ) : isAddExisting || row.mode === "remove" ? (
                                      activeBatches.length > 0 ? (
                                        <BatchSelector
                                          batches={productBatches}
                                          unit={row.unit}
                                          selectedBatchId={row.selectedBatchId}
                                          onSelect={(batchId) => updateRow(idx, { selectedBatchId: batchId })}
                                          mode={isAddExisting ? "add_existing" : "remove"}
                                        />
                                      ) : (
                                        <div className="h-9 px-2 flex items-center text-[11px] text-gray-400 border border-dashed border-gray-200 rounded-lg whitespace-nowrap">No active batches</div>
                                      )
                                    ) : <span className="whitespace-nowrap text-xs text-gray-300">—</span>}
                                  </td>
                                  <td className="border-b border-gray-200 px-2 py-2 align-middle">
                                    {productBatches.length > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => setExpandedBatchProductId((current) => current === row.productId ? "" : row.productId)}
                                        aria-expanded={batchesOpen}
                                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors whitespace-nowrap ${
                                          batchesOpen
                                            ? "border-[#364F9F]/30 bg-[#364F9F]/10 text-[#364F9F]"
                                            : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                        }`}
                                      >
                                        <Layers className="h-3.5 w-3.5" />
                                        <span>Batch info ({productBatches.length})</span>
                                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${batchesOpen ? "rotate-180" : ""}`} />
                                      </button>
                                    ) : <span className="text-xs text-gray-300">—</span>}
                                  </td>
                                </tr>
                                {batchesOpen && (
                                  <tr className="bg-[#364F9F]/[0.025]">
                                    <td colSpan={8} className="border-b border-gray-200 px-4 pb-4 pt-1">
                                      <ExistingBatchesCard
                                        batches={productBatches}
                                        unit={row.unit}
                                        productId={row.productId}
                                        subHubId={selectedSubHubId}
                                        onReload={reload}
                                      />
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={addRow}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#364F9F] hover:text-[#162B4D] transition-colors"
              >
                <Plus className="w-4 h-4" /> Add another product
              </button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={resetForm} className="font-semibold">Reset</Button>
                <Button
                  onClick={handleSave}
                  disabled={saving || !selectedSubHubId}
                  className="bg-[#F05B4E] hover:bg-[#e04a3e] text-white font-semibold shadow-sm"
                >
                  {saving ? "Saving..." : "Save Adjustment"}
                </Button>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </>
  );
}
