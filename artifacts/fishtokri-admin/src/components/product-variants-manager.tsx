import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ProductVariant = {
  _id: string;
  name: string;
  variantGroupId?: string;
  variantLabel: string;
  price: number;
  originalPrice?: number;
  grossWeight?: string;
  netWeight?: string;
  quantity: number;
  isArchived?: boolean;
};

type VariantDraft = {
  price: string;
  originalPrice: string;
  grossWeight: string;
  netWeight: string;
};

function toDraft(variant: ProductVariant): VariantDraft {
  return {
    price: String(variant.price ?? 0),
    originalPrice: String(variant.originalPrice ?? variant.price ?? 0),
    grossWeight: variant.grossWeight ?? "",
    netWeight: variant.netWeight ?? (variant.variantLabel === "Standard" ? "" : variant.variantLabel ?? ""),
  };
}

function getToken() {
  return localStorage.getItem("fishtokri_token") ?? "";
}

async function apiFetchJson(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(options?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed: ${response.status}`);
  }
  return response.json();
}

export function ProductVariantsManager({
  subHubId,
  product,
  onEditVariant,
  onCurrentVariantUpdated,
  onCurrentVariantArchived,
  onSaved,
}: {
  subHubId: string;
  product: any;
  onEditVariant: (variant: ProductVariant) => void;
  onCurrentVariantUpdated: (variantId: string, draft: VariantDraft) => void;
  onCurrentVariantArchived: (variantId: string, isArchived: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [drafts, setDrafts] = useState<Record<string, VariantDraft>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<VariantDraft>(() => ({
    price: String(product?.price ?? ""),
    originalPrice: String(product?.originalPrice ?? product?.price ?? ""),
    grossWeight: "",
    netWeight: "",
  }));

  const loadVariants = useCallback(async () => {
    if (!subHubId || !product?._id) return;
    setLoading(true);
    try {
      const result = await apiFetchJson(
        `/api/sub-hubs/${subHubId}/menu/products/${product._id}/variants`,
      );
      const nextVariants: ProductVariant[] = Array.isArray(result.variants) ? result.variants : [];
      setVariants(nextVariants);
      setDrafts(Object.fromEntries(nextVariants.map((variant) => [String(variant._id), toDraft(variant)])));
    } catch (error: any) {
      toast({ title: "Could not load product variants", description: error.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [product?._id, subHubId, toast]);

  useEffect(() => {
    setAdding(false);
    setNewDraft({
      price: String(product?.price ?? ""),
      originalPrice: String(product?.originalPrice ?? product?.price ?? ""),
      grossWeight: "",
      netWeight: "",
    });
    void loadVariants();
  }, [loadVariants, product?._id]);

  const updateDraft = (variantId: string, values: Partial<VariantDraft>) => {
    setDrafts((current) => ({
      ...current,
      [variantId]: { ...current[variantId], ...values },
    }));
  };

  const saveVariant = async (variant: ProductVariant) => {
    const variantId = String(variant._id);
    const draft = drafts[variantId];
    if (!draft) return;
    const price = Number(draft.price);
    const originalPrice = Number(draft.originalPrice || draft.price);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(originalPrice) || originalPrice < 0) {
      toast({ title: "Enter valid prices", variant: "destructive" });
      return;
    }

    setSavingId(variantId);
    try {
      await apiFetchJson(
        `/api/sub-hubs/${subHubId}/menu/products/${product._id}/variants/${variantId}`,
        {
          method: "PUT",
          body: JSON.stringify({ ...draft, price, originalPrice }),
        },
      );
      if (variantId === String(product._id)) onCurrentVariantUpdated(variantId, draft);
      toast({ title: "Variant updated" });
      await loadVariants();
      onSaved();
    } catch (error: any) {
      toast({ title: "Could not update variant", description: error.message, variant: "destructive" });
    } finally {
      setSavingId("");
    }
  };

  const createVariant = async () => {
    if (!newDraft.netWeight.trim()) {
      toast({ title: "Net weight required", description: "Enter the weight for this variant, such as 500 g.", variant: "destructive" });
      return;
    }
    const price = Number(newDraft.price);
    const originalPrice = Number(newDraft.originalPrice || newDraft.price);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(originalPrice) || originalPrice < 0) {
      toast({ title: "Enter valid prices", variant: "destructive" });
      return;
    }

    setCreating(true);
    try {
      await apiFetchJson(
        `/api/sub-hubs/${subHubId}/menu/products/${product._id}/variants`,
        {
          method: "POST",
          body: JSON.stringify({ price, originalPrice, netWeight: newDraft.netWeight, grossWeight: newDraft.grossWeight }),
        },
      );
      toast({ title: "Weight variant added", description: "Add its stock batches from the variant editor." });
      setAdding(false);
      setNewDraft({
        price: String(product.price ?? ""),
        originalPrice: String(product.originalPrice ?? product.price ?? ""),
        grossWeight: "",
        netWeight: "",
      });
      await loadVariants();
      onSaved();
    } catch (error: any) {
      toast({ title: "Could not add variant", description: error.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const setArchived = async (variant: ProductVariant, isArchived: boolean) => {
    const variantId = String(variant._id);
    setSavingId(variantId);
    try {
      await apiFetchJson(
        `/api/sub-hubs/${subHubId}/menu/products/${product._id}/variants/${variantId}`,
        { method: "PUT", body: JSON.stringify({ isArchived }) },
      );
      if (variantId === String(product._id)) onCurrentVariantArchived(variantId, isArchived);
      toast({ title: isArchived ? "Variant archived" : "Variant restored" });
      await loadVariants();
      onSaved();
    } catch (error: any) {
      toast({ title: "Could not update variant", description: error.message, variant: "destructive" });
    } finally {
      setSavingId("");
    }
  };

  const inputClass = "h-8 w-full min-w-0 rounded-md border border-gray-200 bg-white px-2 text-xs text-[#162B4D] outline-none focus:border-[#1A56DB] focus:ring-1 focus:ring-[#1A56DB]/20 disabled:bg-gray-50";

  return (
    <section className="rounded-xl border border-indigo-100 bg-indigo-50/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#162B4D]">Weight Variants</h3>
          <p className="mt-0.5 text-[11px] text-gray-500">
            Each net weight has its own price, POS item, and stock batches. Unit follows the product.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#364F9F] hover:bg-indigo-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add variant
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading variants…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="border-b border-r border-gray-200 px-2.5 py-2 w-24">Price</th>
                <th className="border-b border-r border-gray-200 px-2.5 py-2 w-28">Net weight</th>
                <th className="border-b border-r border-gray-200 px-2.5 py-2 w-16 text-center">Stock</th>
                <th className="border-b border-gray-200 px-2.5 py-2 w-36">Actions</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => {
                const id = String(variant._id);
                const draft = drafts[id] ?? toDraft(variant);
                const isCurrent = id === String(product._id);
                const isSaving = savingId === id;
                return (
                  <tr key={id} className={variant.isArchived ? "bg-gray-50/80" : "hover:bg-indigo-50/20"}>
                    <td className="border-b border-r border-gray-200 p-2">
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400">₹</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className={inputClass}
                          aria-label={`Price for ${draft.netWeight || variant.variantLabel}`}
                          value={draft.price}
                          onChange={(event) => updateDraft(id, { price: event.target.value })}
                          disabled={isSaving}
                        />
                      </div>
                    </td>
                    <td className="border-b border-r border-gray-200 p-2">
                      <input
                        className={inputClass}
                        aria-label={`Net weight for ${variant.name}`}
                        value={draft.netWeight}
                        onChange={(event) => updateDraft(id, { netWeight: event.target.value })}
                        disabled={isSaving}
                        placeholder="e.g. 500 g"
                      />
                      {variant.isArchived && <span className="mt-1 inline-block text-[10px] font-semibold text-gray-500">Archived — hidden from POS</span>}
                    </td>
                    <td className="border-b border-r border-gray-200 px-2 py-2 text-center font-semibold text-[#162B4D]">
                      {Number(variant.quantity) || 0}
                    </td>
                    <td className="border-b border-gray-200 p-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void saveVariant(variant)}
                          disabled={isSaving}
                          title="Save variant details and price"
                          className="inline-flex h-8 items-center gap-1 rounded-md bg-[#364F9F] px-2 text-[10px] font-semibold text-white hover:bg-[#2b407f] disabled:opacity-50"
                        >
                          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => onEditVariant(variant)}
                          title="Edit product details and batches"
                          className="inline-flex h-8 items-center gap-0.5 rounded-md border border-gray-200 px-2 text-[10px] font-semibold text-gray-600 hover:bg-gray-50"
                        >
                          Batches <ChevronRight className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void setArchived(variant, !variant.isArchived)}
                          disabled={isSaving}
                          aria-label={variant.isArchived ? `Restore ${draft.netWeight || variant.variantLabel}` : `Archive ${draft.netWeight || variant.variantLabel}`}
                          title={variant.isArchived ? "Restore variant" : "Hide variant from POS"}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {variant.isArchived ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {isCurrent && <p className="mt-1 text-[9px] text-gray-400">Current product</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-indigo-100 bg-white p-3 space-y-3">
          <p className="text-xs font-bold text-[#162B4D]">New weight variant</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="space-y-1 text-[10px] font-semibold text-gray-500">
              Sale price *
              <input className={inputClass} type="number" min="0" step="0.01" value={newDraft.price} onChange={(event) => setNewDraft((draft) => ({ ...draft, price: event.target.value }))} required />
            </label>
            <label className="space-y-1 text-[10px] font-semibold text-gray-500">
              Original price
              <input className={inputClass} type="number" min="0" step="0.01" value={newDraft.originalPrice} onChange={(event) => setNewDraft((draft) => ({ ...draft, originalPrice: event.target.value }))} />
            </label>
            <label className="space-y-1 text-[10px] font-semibold text-gray-500">
              Net weight *
              <input className={inputClass} value={newDraft.netWeight} onChange={(event) => setNewDraft((draft) => ({ ...draft, netWeight: event.target.value }))} placeholder="e.g. 500 g" required />
            </label>
            <label className="space-y-1 text-[10px] font-semibold text-gray-500">
              Gross weight
              <input className={inputClass} value={newDraft.grossWeight} onChange={(event) => setNewDraft((draft) => ({ ...draft, grossWeight: event.target.value }))} />
            </label>
          </div>
          <p className="text-[10px] text-gray-500">New variants start with zero stock and a separate batch list.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={() => void createVariant()} disabled={creating} className="rounded-md bg-[#364F9F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2b407f] disabled:opacity-50">
              {creating ? "Adding…" : "Add variant"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
