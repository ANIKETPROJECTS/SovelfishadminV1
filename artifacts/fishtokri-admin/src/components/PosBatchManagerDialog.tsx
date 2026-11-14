import { useCallback, useEffect, useState } from "react";
import { Layers, Plus, RefreshCw, Save, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type WeightUnit = "kg" | "g";
type InventoryMode = "standard" | "whole_fish" | "bulk_portions";

type PosBatchProduct = {
  productId: string;
  subHubId: string;
  superHubId?: string;
  name: string;
  shortCode?: string;
  unit?: string;
  inventoryMode: InventoryMode;
  fishPricePerKg?: number | null;
};

type BatchDraft = {
  _id: string;
  batchNumber: string;
  quantity: number;
  fishWeightKg: number | null;
  fishPrice: number | null;
  fishPricePerKg: number | null;
  receivedDate: string | null;
  expiryDateInput: string;
  originalExpiryDate: string | null;
  shelfLifeDays: number | null;
  notes: string;
  createdAt: string | null;
};

function getBase() {
  return import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(`${getBase()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("fishtokri_token") || ""}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || "Request failed");
  }
  return response.json();
}

function dateOnly(value: unknown): string {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function expiryAtIST(date: string): string | null {
  return date ? `${date}T18:00:00+05:30` : null;
}

function asKg(value: string, unit: WeightUnit): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round((unit === "g" ? parsed / 1000 : parsed) * 1000) / 1000;
}

function displayWeight(value: number | null | undefined, unit: WeightUnit): string {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return unit === "g" ? String(Math.round(Number(value) * 1000)) : String(value);
}

function todayISTCompact(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function batchPrefix(name: string, shortCode?: string): string {
  if (shortCode?.trim()) return shortCode.trim().toUpperCase();
  const words = name.trim().toUpperCase().replace(/[^A-Z\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0].slice(0, 2)}${words[1].slice(0, 2)}`.padEnd(4, "X");
  return (words[0] || "BAT").slice(0, 3).padEnd(3, "X");
}

function generateBatchNumber(product: PosBatchProduct, batches: BatchDraft[]): string {
  const prefix = batchPrefix(product.name, product.shortCode);
  let sequence = 0;
  for (const batch of batches) {
    const value = String(batch.batchNumber || "").toUpperCase();
    const index = value.indexOf(prefix);
    if (index < 0) continue;
    const suffix = value.slice(index + prefix.length);
    if (/^\d{1,5}$/.test(suffix)) sequence = Math.max(sequence, Number(suffix));
  }
  return `${todayISTCompact()}${prefix}${String(sequence + 1).padStart(2, "0")}`;
}

function mapBatch(batch: any): BatchDraft {
  const expiry = batch.expiryDate ? String(batch.expiryDate) : null;
  return {
    _id: String(batch._id ?? batch.id ?? ""),
    batchNumber: String(batch.batchNumber ?? ""),
    quantity: Math.max(0, Number(batch.quantity) || 0),
    fishWeightKg: batch.fishWeightKg == null ? null : Number(batch.fishWeightKg),
    fishPrice: batch.fishPrice == null ? null : Number(batch.fishPrice),
    fishPricePerKg: batch.fishPricePerKg == null ? null : Number(batch.fishPricePerKg),
    receivedDate: batch.receivedDate ? String(batch.receivedDate) : null,
    expiryDateInput: dateOnly(expiry),
    originalExpiryDate: expiry,
    shelfLifeDays: batch.shelfLifeDays == null ? null : Number(batch.shelfLifeDays),
    notes: String(batch.notes ?? ""),
    createdAt: batch.createdAt ? String(batch.createdAt) : null,
  };
}

function WeightUnitToggle({ value, onChange }: { value: WeightUnit; onChange: (unit: WeightUnit) => void }) {
  return (
    <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5" role="group" aria-label="Weight unit">
      {(["kg", "g"] as const).map((unit) => (
        <button
          key={unit}
          type="button"
          aria-pressed={value === unit}
          onClick={() => onChange(unit)}
          className={`rounded px-2 py-1 text-[10px] font-bold uppercase ${
            value === unit ? "bg-[#364F9F] text-white" : "text-gray-500 hover:bg-gray-100"
          }`}
        >
          {unit}
        </button>
      ))}
    </div>
  );
}

export function PosBatchManagerDialog({
  product,
  onClose,
  onSaved,
}: {
  product: PosBatchProduct | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [batches, setBatches] = useState<BatchDraft[]>([]);
  const [originalBatches, setOriginalBatches] = useState<BatchDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingEdits, setSavingEdits] = useState(false);
  const [addingBatch, setAddingBatch] = useState(false);
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("kg");
  const [newBatchNumber, setNewBatchNumber] = useState("");
  const [newStockInput, setNewStockInput] = useState("");
  const [newFishPrice, setNewFishPrice] = useState("");
  const [newExpiryDate, setNewExpiryDate] = useState("");
  const [dirty, setDirty] = useState(false);

  const loadBatches = useCallback(async () => {
    if (!product) return;
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ subHubId: product.subHubId });
      const result = await apiFetch(
        `/api/inventory/products/${encodeURIComponent(product.productId)}/batches?${query.toString()}`,
      );
      const mapped = (Array.isArray(result.batches) ? result.batches : []).map(mapBatch);
      setBatches(mapped);
      setOriginalBatches(mapped);
      setDirty(false);
      setNewBatchNumber(generateBatchNumber(product, mapped));
    } catch (error: any) {
      setLoadError(error?.message || "Could not load this product’s batches.");
    } finally {
      setLoading(false);
    }
  }, [product]);

  useEffect(() => {
    setBatches([]);
    setOriginalBatches([]);
    setDirty(false);
    setWeightUnit("kg");
    setNewStockInput("");
    setNewFishPrice("");
    setNewExpiryDate("");
    if (product) void loadBatches();
  }, [product, loadBatches]);

  function patchBatch(id: string, patch: Partial<BatchDraft>) {
    setBatches((current) => current.map((batch) => batch._id === id ? { ...batch, ...patch } : batch));
    setDirty(true);
  }

  async function saveBatchEdits() {
    if (!product || !dirty) return;
    if (product.inventoryMode === "whole_fish" && batches.some((batch) =>
      ![0, 1].includes(Number(batch.quantity)) ||
      !(Number(batch.fishWeightKg) > 0) ||
      !(Number(batch.fishPrice) > 0)
    )) {
      toast({
        title: "Complete the fish details",
        description: "Each available fish needs a weight and a price greater than zero.",
        variant: "destructive",
      });
      return;
    }
    setSavingEdits(true);
    try {
      // Refresh immediately before replacing the batch array, then apply only
      // fields changed in this form. This preserves newly added batches and
      // quantities deducted by another cashier since the dialog was opened.
      const query = new URLSearchParams({ subHubId: product.subHubId });
      const latestResult = await apiFetch(
        `/api/inventory/products/${encodeURIComponent(product.productId)}/batches?${query.toString()}`,
      );
      const latestBatches: BatchDraft[] = (Array.isArray(latestResult.batches) ? latestResult.batches : []).map(mapBatch);
      const draftById = new Map(batches.map((batch) => [batch._id, batch]));
      const originalById = new Map(originalBatches.map((batch) => [batch._id, batch]));
      const updated = latestBatches.map((latest) => {
        const batch = draftById.get(latest._id);
        const original = originalById.get(latest._id);
        if (!batch || !original) return latest;
        const batchNumber = batch.batchNumber !== original.batchNumber ? batch.batchNumber.trim() : latest.batchNumber;
        const quantity = Number(batch.quantity) !== Number(original.quantity) ? Number(batch.quantity) || 0 : latest.quantity;
        const fishWeightKg = batch.fishWeightKg !== original.fishWeightKg ? batch.fishWeightKg : latest.fishWeightKg;
        const fishPrice = batch.fishPrice !== original.fishPrice ? batch.fishPrice : latest.fishPrice;
        const fishPricePerKg = batch.fishPricePerKg !== original.fishPricePerKg
          ? batch.fishPricePerKg
          : latest.fishPricePerKg;
        const expiryWasEdited = batch.expiryDateInput !== dateOnly(original.originalExpiryDate);
        const expiryDate = expiryWasEdited
          ? expiryAtIST(batch.expiryDateInput)
          : latest.originalExpiryDate;
        return {
          _id: latest._id,
          batchNumber,
          quantity,
          ...(product.inventoryMode === "whole_fish" ? {
            fishWeightKg,
            fishPrice,
            ...(fishPricePerKg != null ? { fishPricePerKg } : {}),
          } : {}),
          shelfLifeDays: latest.shelfLifeDays,
          receivedDate: latest.receivedDate,
          expiryDate,
          notes: latest.notes,
          ...(latest.createdAt ? { createdAt: latest.createdAt } : {}),
        };
      });
      await apiFetch(
        `/api/inventory/products/${encodeURIComponent(product.productId)}/batches?subHubId=${encodeURIComponent(product.subHubId)}`,
        { method: "PUT", body: JSON.stringify({ batches: updated }) },
      );
      toast({ title: "Batches updated" });
      await loadBatches();
      await onSaved();
    } catch (error: any) {
      toast({
        title: "Could not update batches",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingEdits(false);
    }
  }

  async function addBatch() {
    if (!product) return;
    const wholeFish = product.inventoryMode === "whole_fish";
    const bulkFish = product.inventoryMode === "bulk_portions";
    const parsedStock = wholeFish || bulkFish
      ? asKg(newStockInput, weightUnit)
      : Number(newStockInput);
    if (parsedStock == null || !Number.isFinite(parsedStock) || parsedStock <= 0) {
      toast({
        title: "Enter a valid stock amount",
        description: wholeFish ? "Enter this fish’s weight." : bulkFish ? "Enter the incoming weight." : `Enter a quantity in ${product.unit || "stock units"}.`,
        variant: "destructive",
      });
      return;
    }
    const rate = Number(product.fishPricePerKg) > 0 ? Number(product.fishPricePerKg) : null;
    const fishPrice = wholeFish
      ? rate ? Math.round(parsedStock * rate) : Number(newFishPrice)
      : undefined;
    if (wholeFish && (!Number.isFinite(fishPrice) || Number(fishPrice) <= 0)) {
      toast({
        title: "Enter a total price",
        description: "This product has no selling rate per kilogram, so enter the price for this fish.",
        variant: "destructive",
      });
      return;
    }
    setAddingBatch(true);
    try {
      await apiFetch("/api/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify({
          subHubId: product.subHubId,
          ...(product.superHubId ? { superHubId: product.superHubId } : {}),
          date: new Date().toISOString(),
          reason: "POS stock addition",
          notes: `Batch added from POS for ${product.name}`,
          items: [{
            productId: product.productId,
            mode: "add",
            addQuantity: wholeFish ? 1 : parsedStock,
            batchNumber: newBatchNumber.trim() || generateBatchNumber(product, batches),
            receivedDate: new Date().toISOString(),
            expiryDate: expiryAtIST(newExpiryDate),
            ...(wholeFish ? {
              fishWeightKg: parsedStock,
              fishPrice: Number(fishPrice),
              ...(rate ? { fishPricePerKg: rate } : {}),
            } : {}),
          }],
        }),
      });
      toast({ title: "Batch added to stock" });
      setNewStockInput("");
      setNewFishPrice("");
      setNewExpiryDate("");
      await loadBatches();
      await onSaved();
    } catch (error: any) {
      toast({
        title: "Could not add batch",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setAddingBatch(false);
    }
  }

  const isOpen = Boolean(product);
  const needsWeight = product?.inventoryMode === "whole_fish" || product?.inventoryMode === "bulk_portions";
  const unitLabel = product?.inventoryMode === "whole_fish"
    ? "fish"
    : product?.inventoryMode === "bulk_portions"
      ? "kg"
      : product?.unit || "units";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#162B4D]">
            <Layers className="h-4 w-4 text-[#364F9F]" />
            Manage batches{product ? ` — ${product.name}` : ""}
          </DialogTitle>
        </DialogHeader>

        {!product ? null : (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
            <p className="text-xs text-gray-500">
              Changes apply to this product’s stock at the selected sub hub. Leave expiry blank for stock with no expiry date.
            </p>
            {loadError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {loadError}
                <Button type="button" variant="outline" size="sm" className="ml-3 h-7" onClick={() => void loadBatches()}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Retry
                </Button>
              </div>
            )}

            <section className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-[#364F9F]">Existing batches</h3>
                  <p className="text-[11px] text-gray-500">{batches.length} batch{batches.length === 1 ? "" : "es"} · editing weight recalculates whole-fish price when a rate is available</p>
                </div>
                {needsWeight && <WeightUnitToggle value={weightUnit} onChange={setWeightUnit} />}
              </div>
              {loading ? (
                <div className="py-8 text-center text-sm text-gray-400">Loading batches…</div>
              ) : batches.length === 0 ? (
                <div className="py-7 text-center text-sm text-gray-400">No batches yet. Add the first batch below.</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {batches.map((batch, index) => {
                    const rate = Number(batch.fishPricePerKg) > 0
                      ? Number(batch.fishPricePerKg)
                      : Number(product.fishPricePerKg) > 0 ? Number(product.fishPricePerKg) : null;
                    return (
                      <div key={batch._id || `${batch.batchNumber}-${index}`} className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-12 sm:items-end">
                        <div className="sm:col-span-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Batch ID</label>
                          <Input value={batch.batchNumber} onChange={(event) => patchBatch(batch._id, { batchNumber: event.target.value.toUpperCase() })} className="h-8 text-xs" />
                        </div>
                        {product.inventoryMode === "whole_fish" ? (
                          <>
                            <div className="sm:col-span-3">
                              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Weight ({weightUnit})</label>
                              <Input
                                type="number"
                                min="0"
                                step={weightUnit === "g" ? "1" : "0.001"}
                                value={displayWeight(batch.fishWeightKg, weightUnit)}
                                onChange={(event) => {
                                  const kg = asKg(event.target.value, weightUnit);
                                  patchBatch(batch._id, {
                                    fishWeightKg: kg,
                                    ...(kg != null && rate ? { fishPricePerKg: rate, fishPrice: Math.round(kg * rate) } : {}),
                                  });
                                }}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Total price</label>
                              <Input type="number" min="0" step="1" value={batch.fishPrice ?? ""} onChange={(event) => patchBatch(batch._id, { fishPrice: event.target.value === "" ? null : Number(event.target.value) })} className="h-8 text-xs" />
                            </div>
                            <div className="sm:col-span-1">
                              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Stock</label>
                              <div className="flex h-8 items-center rounded-md border bg-gray-50 px-2 text-xs text-gray-600">{batch.quantity} fish</div>
                            </div>
                          </>
                        ) : (
                          <div className="sm:col-span-3">
                            <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">
                              Stock ({product.inventoryMode === "bulk_portions" ? weightUnit : unitLabel})
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step={product.inventoryMode === "bulk_portions" ? (weightUnit === "g" ? "1" : "0.001") : "1"}
                              value={product.inventoryMode === "bulk_portions"
                                ? displayWeight(batch.quantity, weightUnit)
                                : String(batch.quantity)}
                              onChange={(event) => {
                                const value = product.inventoryMode === "bulk_portions"
                                  ? asKg(event.target.value, weightUnit)
                                  : Number(event.target.value);
                                patchBatch(batch._id, { quantity: value == null || !Number.isFinite(value) ? 0 : Math.max(0, value) });
                              }}
                              className="h-8 text-xs"
                            />
                          </div>
                        )}
                        <div className={product.inventoryMode === "whole_fish" ? "sm:col-span-3" : "sm:col-span-4"}>
                          <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Expiry (optional)</label>
                          <Input type="date" value={batch.expiryDateInput} onChange={(event) => patchBatch(batch._id, { expiryDateInput: event.target.value })} className="h-8 text-xs" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {dirty && (
                <div className="flex items-center justify-between gap-2 border-t bg-blue-50/60 px-3 py-2">
                  <span className="text-xs text-blue-800">Save or discard edits before adding another batch.</span>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={savingEdits} onClick={() => void loadBatches()} className="h-8">Discard</Button>
                    <Button type="button" size="sm" disabled={savingEdits || loading} onClick={() => void saveBatchEdits()} className="h-8 bg-[#364F9F] text-white hover:bg-[#2d417f]">
                      <Save className="mr-1 h-3.5 w-3.5" /> {savingEdits ? "Saving…" : "Save edits"}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-[#364F9F]/20 bg-[#364F9F]/[0.025] p-3">
              <div className="mb-3 flex items-center gap-2">
                <Plus className="h-4 w-4 text-[#364F9F]" />
                <h3 className="text-xs font-bold uppercase tracking-wide text-[#364F9F]">Add a batch</h3>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
                <div className="sm:col-span-3">
                  <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Batch ID</label>
                  <Input value={newBatchNumber} onChange={(event) => setNewBatchNumber(event.target.value.toUpperCase())} className="h-9 text-xs" />
                </div>
                <div className={product.inventoryMode === "whole_fish" ? "sm:col-span-3" : "sm:col-span-4"}>
                  <label className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase text-gray-500">
                    <span>{product.inventoryMode === "whole_fish" ? `Fish weight (${weightUnit})` : product.inventoryMode === "bulk_portions" ? `Incoming weight (${weightUnit})` : `Quantity (${unitLabel})`}</span>
                    {needsWeight && <WeightUnitToggle value={weightUnit} onChange={setWeightUnit} />}
                  </label>
                  <Input
                    type="number"
                    min="0"
                    step={needsWeight ? (weightUnit === "g" ? "1" : "0.001") : "1"}
                    value={newStockInput}
                    onChange={(event) => setNewStockInput(event.target.value)}
                    placeholder={product.inventoryMode === "whole_fish" ? (weightUnit === "g" ? "e.g. 1200" : "e.g. 1.2") : product.inventoryMode === "bulk_portions" ? (weightUnit === "g" ? "e.g. 5000" : "e.g. 5") : "e.g. 10"}
                    className="h-9 text-xs"
                  />
                </div>
                {product.inventoryMode === "whole_fish" && (
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Total price</label>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      value={Number(product.fishPricePerKg) > 0 && asKg(newStockInput, weightUnit) != null
                        ? String(Math.round(Number(asKg(newStockInput, weightUnit)) * Number(product.fishPricePerKg)))
                        : newFishPrice}
                      onChange={(event) => setNewFishPrice(event.target.value)}
                      placeholder={Number(product.fishPricePerKg) > 0 ? `₹${Math.round(Number(asKg(newStockInput, weightUnit) || 0) * Number(product.fishPricePerKg))}` : "₹"}
                      readOnly={Number(product.fishPricePerKg) > 0}
                      className="h-9 text-xs"
                    />
                  </div>
                )}
                <div className="sm:col-span-3">
                  <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Expiry (optional)</label>
                  <Input type="date" value={newExpiryDate} onChange={(event) => setNewExpiryDate(event.target.value)} className="h-9 text-xs" />
                </div>
                <div className="sm:col-span-1">
                  <Button type="button" onClick={() => void addBatch()} disabled={addingBatch || loading || dirty || Boolean(loadError)} className="h-9 w-full bg-[#1A56DB] text-white hover:bg-[#1447B4]">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="mt-2 flex items-center gap-1 text-[10px] text-gray-500">
                <Scale className="h-3 w-3" />
                {product.inventoryMode === "whole_fish"
                  ? "One fish is added per batch. Its total price uses the saved per-kg rate when available."
                  : product.inventoryMode === "bulk_portions"
                    ? "Stock is stored in kilograms; grams are converted before saving."
                    : `The batch will be added in ${unitLabel}.`}
              </p>
            </section>
          </div>
        )}
        <DialogFooter className="border-t pt-3">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
