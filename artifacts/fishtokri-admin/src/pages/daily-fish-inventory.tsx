import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, Fish, Plus, RefreshCw, Scale, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

type SourceProduct = { id: string; name: string; category: string; imageUrl?: string; unit: string };
type DailyFishEntry = {
  id: string;
  sourceProductId: string;
  sourceProductName: string;
  name: string;
  category: string;
  weightKg: number;
  netWeight: string;
  variantLabel: string;
  price: number;
  quantity: number;
  unit: string;
  dailyFishDate: string;
  createdAt: string;
  imageUrl?: string;
};
type DailyFishResponse = { subHub: { id: string; name: string }; sourceProducts: SourceProduct[]; entries: DailyFishEntry[] };
type FishRow = { key: number; weightKg: string; totalPrice: string };

function money(value: number) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(value: string) {
  if (!value) return "Selected day";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function DailyFishIntakePanel({
  subHubId,
  date,
  reason,
  notes,
  onSaved,
}: {
  subHubId: string;
  date: string;
  reason: string;
  notes: string;
  onSaved?: () => void;
}) {
  const [sourceProducts, setSourceProducts] = useState<SourceProduct[]>([]);
  const [entries, setEntries] = useState<DailyFishEntry[]>([]);
  const [parentProductId, setParentProductId] = useState("");
  const [rows, setRows] = useState<FishRow[]>([{ key: 1, weightKg: "", totalPrice: "" }]);
  const [nextRowKey, setNextRowKey] = useState(2);
  const [initialLoading, setInitialLoading] = useState(true);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});

  const loadDay = useCallback(async (quiet = false) => {
    if (!subHubId || !date) {
      setEntries([]);
      setSourceProducts([]);
      setInitialLoading(false);
      return;
    }
    if (!quiet) setEntriesLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ subHubId, date });
      const result = await apiFetch(`/api/inventory/daily-fish?${query.toString()}`) as DailyFishResponse;
      setEntries(Array.isArray(result.entries) ? result.entries : []);
      setSourceProducts(Array.isArray(result.sourceProducts) ? result.sourceProducts : []);
      setParentProductId((current) => result.sourceProducts?.some((product) => product.id === current)
        ? current
        : result.sourceProducts?.[0]?.id ?? "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load daily fish intake.");
      setEntries([]);
      setSourceProducts([]);
    } finally {
      setEntriesLoading(false);
      setInitialLoading(false);
    }
  }, [subHubId, date]);

  useEffect(() => { void loadDay(); }, [loadDay]);

  const chosenProduct = sourceProducts.find((product) => product.id === parentProductId);
  const totalWeight = useMemo(() => entries.reduce((sum, entry) => sum + (Number(entry.weightKg) || 0), 0), [entries]);
  const availableCount = useMemo(() => entries.filter((entry) => entry.quantity > 0).length, [entries]);
  const soldCount = entries.length - availableCount;
  const draftTotal = useMemo(() => rows.reduce((sum, row) => sum + (Number(row.totalPrice) || 0), 0), [rows]);
  const draftWeight = useMemo(() => rows.reduce((sum, row) => sum + (Number(row.weightKg) || 0), 0), [rows]);

  function updateRow(key: number, patch: Partial<FishRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSubmitError("");
  }

  function addRow() {
    setRows((current) => [...current, { key: nextRowKey, weightKg: "", totalPrice: "" }]);
    setNextRowKey((key) => key + 1);
  }

  function removeRow(key: number) {
    setRows((current) => current.length > 1 ? current.filter((row) => row.key !== key) : current);
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submitIntake(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setSuccessMessage("");
    const errors: Record<number, string> = {};
    rows.forEach((row, index) => {
      const weight = Number(row.weightKg);
      const price = Number(row.totalPrice);
      if (!row.weightKg || !Number.isFinite(weight) || weight <= 0) {
        errors[row.key] = "Enter a weight greater than 0 kg.";
      } else if (!row.totalPrice || !Number.isFinite(price) || price <= 0) {
        errors[row.key] = "Enter a total price greater than ₹0.";
      }
      if (index >= 0 && !parentProductId) errors[row.key] = "Choose a parent fish product first.";
    });
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setSubmitError("Check the highlighted fields before saving.");
      return;
    }
    if (!subHubId || !date) {
      setSubmitError("Choose a sub-hub and date before saving intake.");
      return;
    }
    if (!reason.trim()) {
      setSubmitError("Enter a reason in Adjustment Details before saving intake.");
      return;
    }
    setSaving(true);
    try {
      const result = await apiFetch("/api/inventory/daily-fish", {
        method: "POST",
        body: JSON.stringify({
          subHubId,
          sourceProductId: parentProductId,
          date,
          reason,
          notes,
          entries: rows.map((row) => ({ weightKg: Number(row.weightKg), totalPrice: Number(row.totalPrice) })),
        }),
      });
      const createdCount = Number(result.created ?? result.entries?.length ?? rows.length);
      setRows([{ key: nextRowKey, weightKg: "", totalPrice: "" }]);
      setNextRowKey((key) => key + 1);
      setFieldErrors({});
      setSuccessMessage(`${createdCount} ${createdCount === 1 ? "fish" : "fish"} added to ${dateLabel(date)} intake.`);
      await loadDay(true);
      onSaved?.();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save fish intake. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const noSubHub = !subHubId;
  const noProducts = !entriesLoading && sourceProducts.length === 0 && !!subHubId;

  return (
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <form onSubmit={submitIntake} className="overflow-hidden rounded-2xl border border-[#dce5df] bg-[#fbfcf8] shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e5ebe6] px-5 py-4 sm:px-6">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b9a93]">Daily stock</p>
              <h2 className="mt-1 text-lg font-bold text-[#183943]">Record individual fish</h2>
              <p className="mt-1 text-xs text-[#84938c]">Enter each fish’s weight and total price. Date, reason, and notes come from Adjustment Details above.</p>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-[#607a78]">
              <span className="rounded-full bg-[#e5f2e7] px-3 py-2 text-[#467754]">{availableCount} in stock</span>
              <span className="rounded-full bg-[#f2e9e5] px-3 py-2 text-[#9b6755]">{soldCount} sold</span>
              <span className="rounded-lg border border-[#dce5df] bg-white px-3 py-2">{dateLabel(date)}</span>
            </div>
          </div>

          <div className="space-y-5 px-5 py-5 sm:px-6">
            {initialLoading ? (
              <div className="space-y-4" aria-label="Loading intake form">
                <div className="h-10 animate-pulse rounded-lg bg-[#e8eeea]" />
                <div className="h-16 animate-pulse rounded-lg bg-[#e8eeea]" />
                <div className="h-16 animate-pulse rounded-lg bg-[#e8eeea]" />
              </div>
            ) : (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-[#637a7b]">Parent fish product</span>
                  <select
                    value={parentProductId}
                    onChange={(event) => setParentProductId(event.target.value)}
                    disabled={!sourceProducts.length || saving}
                    className="h-11 w-full rounded-lg border border-[#d7e1dc] bg-white px-3 text-sm font-semibold text-[#183943] outline-none transition focus:border-[#4b8177] focus:ring-2 focus:ring-[#4b8177]/15 disabled:cursor-not-allowed disabled:bg-[#f2f5f1] disabled:text-[#91a09a]"
                    aria-label="Choose parent fish product"
                    data-testid="select-parent-fish"
                  >
                    <option value="">Choose a regular fish product</option>
                    {sourceProducts.map((product) => (
                      <option key={product.id} value={product.id}>{product.name}{product.category ? ` · ${product.category}` : ""}</option>
                    ))}
                  </select>
                  {chosenProduct && <span className="block text-xs text-[#84938c]">All entries below will be listed under {chosenProduct.name}.</span>}
                </label>

                {noProducts && (
                  <div className="rounded-xl border border-dashed border-[#cad8d1] bg-[#f4f7f3] px-4 py-5 text-center">
                    <Fish className="mx-auto h-6 w-6 text-[#71958b]" />
                    <p className="mt-2 text-sm font-semibold text-[#365a5f]">No regular fish products found</p>
                    <p className="mt-1 text-xs text-[#81918a]">Set up a parent fish product for this sub-hub before receiving individual fish.</p>
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-[#dce5df]">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] gap-3 bg-[#eef3ee] px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#71827c] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_42px] sm:px-4">
                    <span>Whole fish weight <span className="normal-case tracking-normal">(kg)</span></span>
                    <span>Total price <span className="normal-case tracking-normal">(₹ / fish)</span></span>
                    <span className="sr-only">Remove row</span>
                  </div>
                  <div className="divide-y divide-[#e8eeea]">
                    {rows.map((row, index) => (
                      <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] items-start gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_42px] sm:px-4" data-testid={`row-fish-entry-${row.key}`}>
                        <label className="min-w-0">
                          <span className="sr-only">Weight in kilograms, fish {index + 1}</span>
                          <span className="relative block">
                            <input
                              type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="e.g. 2.40"
                              value={row.weightKg} onChange={(event) => updateRow(row.key, { weightKg: event.target.value })}
                              aria-label={`Weight in kilograms, fish ${index + 1}`} aria-invalid={!!fieldErrors[row.key]}
                              className="h-10 w-full rounded-lg border border-[#d7e1dc] bg-white px-3 pr-9 text-sm font-semibold tabular-nums text-[#183943] outline-none focus:border-[#4b8177] focus:ring-2 focus:ring-[#4b8177]/15"
                              data-testid={`input-fish-weight-${row.key}`}
                            />
                            <Scale className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-[#91a39c]" />
                          </span>
                        </label>
                        <label className="min-w-0">
                          <span className="sr-only">Total price in rupees, fish {index + 1}</span>
                          <span className="relative block">
                            <span className="pointer-events-none absolute left-3 top-2.5 text-sm font-semibold text-[#91a39c]">₹</span>
                            <input
                              type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="e.g. 680"
                              value={row.totalPrice} onChange={(event) => updateRow(row.key, { totalPrice: event.target.value })}
                              aria-label={`Total price in rupees, fish ${index + 1}`} aria-invalid={!!fieldErrors[row.key]}
                              className="h-10 w-full rounded-lg border border-[#d7e1dc] bg-white pl-7 pr-3 text-sm font-semibold tabular-nums text-[#183943] outline-none focus:border-[#4b8177] focus:ring-2 focus:ring-[#4b8177]/15"
                              data-testid={`input-fish-price-${row.key}`}
                            />
                          </span>
                        </label>
                        <button type="button" onClick={() => removeRow(row.key)} disabled={rows.length === 1 || saving} aria-label={`Remove fish ${index + 1}`} title="Remove row" className="flex h-10 w-10 items-center justify-center rounded-lg text-[#93a29c] transition hover:bg-[#f9e9e5] hover:text-[#a14a3d] disabled:cursor-not-allowed disabled:opacity-30" data-testid={`button-remove-fish-row-${row.key}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                        {fieldErrors[row.key] && (
                          <p className="col-span-3 -mt-1 flex items-center gap-1 text-xs font-medium text-[#a14a3d]" role="alert">
                            <AlertCircle className="h-3.5 w-3.5" /> {fieldErrors[row.key]}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={addRow} disabled={saving || !sourceProducts.length} className="flex w-full items-center justify-center gap-2 border-t border-[#e8eeea] bg-[#f8faf6] px-4 py-3 text-sm font-semibold text-[#44766d] transition hover:bg-[#eef5ef] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-fish-row">
                    <Plus className="h-4 w-4" /> Add another fish
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#edf3ee] px-4 py-3">
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#607a78]">
                    <span><strong className="text-[#254951]">{rows.length}</strong> fish in this save</span>
                    <span><strong className="text-[#254951]">{draftWeight.toFixed(2)} kg</strong> total weight</span>
                  </div>
                  <p className="text-sm font-bold tabular-nums text-[#183943]">{money(draftTotal)}</p>
                </div>

                {(submitError || successMessage) && (
                  <div role={submitError ? "alert" : "status"} className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${submitError ? "border border-[#edc9be] bg-[#fff4ef] text-[#9a4739]" : "border border-[#c5dfce] bg-[#edf7ee] text-[#37694a]"}`} data-testid={submitError ? "status-intake-error" : "status-intake-success"}>
                    {submitError ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
                    <span>{submitError || successMessage}</span>
                  </div>
                )}

                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-relaxed text-[#81918a]">Each saved fish is added with quantity 1 and its own fixed total price.</p>
                  <button type="submit" disabled={saving || !subHubId || !parentProductId || !sourceProducts.length} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#d59b4d] px-5 text-sm font-bold text-[#253d3c] shadow-sm transition hover:bg-[#e0aa5c] focus:outline-none focus:ring-2 focus:ring-[#d59b4d]/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-save-daily-fish">
                    {saving ? <><RefreshCw className="h-4 w-4 animate-spin" /> Saving fish…</> : <>Save intake <ChevronRight className="h-4 w-4" /></>}
                  </button>
                </div>
              </>
            )}
          </div>
        </form>

        <section className="overflow-hidden rounded-2xl border border-[#dce5df] bg-[#fbfcf8] shadow-sm" aria-labelledby="today-entries-title">
          <div className="flex items-start justify-between gap-3 border-b border-[#e5ebe6] px-5 py-4 sm:px-6">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b9a93]">Shift ledger</p>
              <h2 id="today-entries-title" className="mt-1 text-lg font-bold text-[#183943]">Day’s fish entries</h2>
              <p className="mt-1 text-xs text-[#84938c]">{dateLabel(date)}</p>
            </div>
            <button type="button" onClick={() => void loadDay()} disabled={entriesLoading || !subHubId} aria-label="Refresh fish entries" title="Refresh entries" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#dce5df] bg-white text-[#5f7c7c] transition hover:bg-[#f1f5f1] disabled:opacity-50" data-testid="button-refresh-fish-entries">
              <RefreshCw className={`h-4 w-4 ${entriesLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="flex items-center justify-between border-b border-[#e8eeea] bg-[#f5f8f4] px-5 py-3 text-xs sm:px-6">
            <span className="font-semibold text-[#71827c]">{entries.length} total entries</span>
            <span className="font-medium text-[#55776c]">{totalWeight.toFixed(2)} kg received</span>
          </div>

          <div className="max-h-[620px] overflow-y-auto">
            {entriesLoading || (initialLoading && !entries.length) ? (
              <div className="space-y-3 p-5" aria-label="Loading daily fish entries">
                {[0, 1, 2, 3].map((item) => <div key={item} className="h-[68px] animate-pulse rounded-xl bg-[#edf2ed]" />)}
              </div>
            ) : loadError ? (
              <div className="px-5 py-12 text-center">
                <AlertCircle className="mx-auto h-8 w-8 text-[#bc7662]" />
                <p className="mt-3 text-sm font-semibold text-[#4f6262]">Entries could not be loaded</p>
                <p className="mt-1 text-xs text-[#84938c]">{loadError}</p>
                <button type="button" onClick={() => void loadDay()} className="mt-4 rounded-lg border border-[#d3dfd8] bg-white px-3 py-2 text-xs font-semibold text-[#416b65] hover:bg-[#f1f6f1]" data-testid="button-retry-daily-fish">Try again</button>
              </div>
            ) : noSubHub ? (
              <div className="px-5 py-12 text-center">
                <Fish className="mx-auto h-8 w-8 text-[#a0b5ac]" />
                <p className="mt-3 text-sm font-semibold text-[#4f6262]">No sub-hub available</p>
                <p className="mt-1 text-xs text-[#84938c]">Your account does not currently have an inventory location assigned.</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#eaf1eb] text-[#547d73]">
                  <Fish className="h-5 w-5" />
                </div>
                <p className="mt-3 text-sm font-semibold text-[#36565b]">No fish logged for this date</p>
                <p className="mx-auto mt-1 max-w-[230px] text-xs leading-relaxed text-[#84938c]">Saved intake will appear here with its live stock availability.</p>
              </div>
            ) : (
              <ul className="divide-y divide-[#e8eeea]">
                {entries.map((entry, index) => {
                  const isAvailable = entry.quantity > 0;
                  const label = entry.variantLabel || `${Number(entry.weightKg).toFixed(2)} kg`;
                  return (
                    <li key={entry.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5" data-testid={`row-daily-fish-entry-${entry.id}`}>
                      {entry.imageUrl ? (
                        <img src={entry.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#e8f0ea] text-[#628679]"><Fish className="h-4 w-4" /></div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-[#26464d]">{entry.name || `${entry.sourceProductName} · ${label}`}</p>
                        <p className="mt-0.5 truncate text-xs text-[#87968f]">{entry.sourceProductName} <span className="px-1">·</span> {label}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-bold tabular-nums text-[#294b50]">{money(entry.price)}</p>
                        <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${isAvailable ? "bg-[#e5f2e7] text-[#467754]" : "bg-[#f2e9e5] text-[#9b6755]"}`} data-testid={`status-fish-stock-${entry.id}`}>
                          {isAvailable ? "In stock" : "Sold"}
                        </span>
                      </div>
                      <span className="sr-only">Entry {index + 1}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {entries.length > 0 && !entriesLoading && (
            <div className="flex items-center justify-between border-t border-[#e8eeea] px-5 py-3 text-[11px] text-[#87968f]">
              <span>{availableCount} available · {soldCount} sold</span>
              <span>{entries.length} sellable {entries.length === 1 ? "unit" : "units"} received</span>
            </div>
          )}
        </section>
      </section>
  );
}
