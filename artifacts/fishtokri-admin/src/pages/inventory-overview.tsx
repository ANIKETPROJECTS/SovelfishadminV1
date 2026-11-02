import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight, Boxes, Building2, History, Package, RefreshCw, SlidersHorizontal,
  AlertTriangle, IndianRupee, TrendingUp, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type InventoryAnalytics = {
  overview: {
    totalSubHubs: number;
    trackedSubHubs: number;
    totalProducts: number;
    activeProducts: number;
    outOfStockCount: number;
    lowStockCount: number;
    totalStockValue: number;
    totalQuantity: number;
    categoryCount: number;
    movementsTotal: number;
    movements30d: number;
    adjustmentsTotal: number;
    adjustments30d: number;
  };
  lowStock: Array<{ id: string; name: string; variantLabel?: string; quantity: number; unit: string; category: string; subHubName: string }>;
  recentMovements: Array<{ _id?: string; type: string; productName?: string; change?: number; balance?: number; orderRef?: string; reason?: string; subHubName?: string; createdAt?: string }>;
  subHubBreakdown: Array<{ id: string; name: string; products: number; outOfStock: number; lowStock: number; stockValue: number }>;
};

function getToken() {
  return localStorage.getItem("fishtokri_token") ?? "";
}

async function apiFetch(path: string) {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  const res = await fetch(`${base}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Request failed");
  return data;
}

function formatRupees(value: number) {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatCard({ title, value, helper, icon: Icon, tone = "blue" }: { title: string; value: string | number; helper: string; icon: any; tone?: "blue" | "green" | "amber" | "purple" | "red" }) {
  const tones: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    purple: "bg-purple-50 text-purple-600",
    red: "bg-red-50 text-red-600",
  };
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400 font-semibold uppercase tracking-wide">{title}</p>
          <p className="text-2xl font-bold text-[#162B4D] mt-2">{value}</p>
          <p className="text-xs text-gray-500 mt-1">{helper}</p>
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tones[tone]}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

function SectionLink({ href, label, description, icon: Icon }: { href: string; label: string; description: string; icon: any }) {
  return (
    <Link href={href}>
      <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm hover:shadow-md hover:border-blue-100 transition-all cursor-pointer">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#162B4D]/10 text-[#162B4D] flex items-center justify-center">
            <Icon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-[#162B4D]">{label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          </div>
          <ArrowRight className="w-4 h-4 text-gray-300" />
        </div>
      </div>
    </Link>
  );
}

const MOVEMENT_LABELS: Record<string, string> = {
  order_deduct: "Order deduction",
  order_restore: "Order restored",
  adjustment: "Stock adjustment",
};

export default function InventoryOverview() {
  const { toast } = useToast();
  const [data, setData] = useState<InventoryAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const result = await apiFetch("/api/inventory/analytics/summary");
      setData(result);
    } catch (err: any) {
      toast({ title: "Could not load inventory analytics", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const overview = data?.overview;
  const maxSubValue = useMemo(
    () => Math.max(1, ...((data?.subHubBreakdown ?? []).map((s) => s.stockValue))),
    [data?.subHubBreakdown]
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#162B4D]">Inventory Management</h1>
          <p className="text-sm text-gray-500 mt-1">Overall analytics for stock levels, movements, and adjustments across sub-hubs.</p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title="Total Products"
          value={overview?.totalProducts ?? "—"}
          helper={`${overview?.activeProducts ?? 0} available, across ${overview?.trackedSubHubs ?? 0} sub-hubs`}
          icon={Package}
          tone="blue"
        />
        <StatCard
          title="Stock Value"
          value={overview ? formatRupees(overview.totalStockValue) : "—"}
          helper={`${(overview?.totalQuantity ?? 0).toLocaleString("en-IN")} units in stock`}
          icon={IndianRupee}
          tone="green"
        />
        <StatCard
          title="Low Stock"
          value={overview?.lowStockCount ?? "—"}
          helper={`${overview?.outOfStockCount ?? 0} out of stock`}
          icon={AlertTriangle}
          tone="amber"
        />
        <StatCard
          title="Movements (30d)"
          value={overview?.movements30d ?? "—"}
          helper={`${overview?.adjustments30d ?? 0} adjustments • ${overview?.movementsTotal ?? 0} all-time`}
          icon={TrendingUp}
          tone="purple"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SectionLink href="/inventory/products" label="Inventory" description={`${overview?.totalProducts ?? 0} products tracked across sub-hubs.`} icon={Boxes} />
        <SectionLink href="/inventory/history" label="History" description={`${overview?.movementsTotal ?? 0} stock movements recorded.`} icon={History} />
        <SectionLink href="/inventory/adjustment" label="Stock Management" description={`${overview?.adjustmentsTotal ?? 0} adjustments logged.`} icon={SlidersHorizontal} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-5">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-[#162B4D]">Stock Value by Sub-hub</h2>
              <p className="text-xs text-gray-400 mt-0.5">Top sub-hubs by current stock valuation.</p>
            </div>
            <Layers className="w-4 h-4 text-gray-300" />
          </div>
          <div className="p-5 space-y-4">
            {loading ? (
              <div className="h-36 rounded-xl bg-gray-50 animate-pulse" />
            ) : data?.subHubBreakdown.length ? (
              data.subHubBreakdown.map((s) => (
                <div key={s.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-[#162B4D] flex items-center gap-2">
                      <Building2 className="w-3.5 h-3.5 text-gray-400" />
                      {s.name}
                    </span>
                    <span className="text-gray-500">{formatRupees(s.stockValue)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full bg-[#1A56DB]" style={{ width: `${Math.max(4, (s.stockValue / maxSubValue) * 100)}%` }} />
                  </div>
                  <p className="text-[11px] text-gray-400">
                    {s.products} products • {s.lowStock} low • {s.outOfStock} out
                  </p>
                </div>
              ))
            ) : (
              <div className="text-center py-12">
                <Package className="w-10 h-10 mx-auto text-gray-200" />
                <p className="text-sm font-medium text-gray-500 mt-3">No sub-hub inventory yet</p>
                <p className="text-xs text-gray-400 mt-1">Set up products in a sub-hub to see analytics.</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-[#162B4D]">Low Stock Alerts</h2>
              <p className="text-xs text-gray-400 mt-0.5">Items with fewer than 5 units remaining.</p>
            </div>
            <div className="divide-y divide-gray-100">
              {loading ? (
                <div className="p-5 space-y-3">
                  <div className="h-12 bg-gray-50 rounded-lg animate-pulse" />
                  <div className="h-12 bg-gray-50 rounded-lg animate-pulse" />
                </div>
              ) : data?.lowStock.length ? (
                data.lowStock.map((p) => (
                  <div key={`${p.id}-${p.subHubName}`} className="p-4 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                      <AlertTriangle className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-[#162B4D] truncate">
                        {p.name}{p.variantLabel ? ` (${p.variantLabel})` : ""}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {p.subHubName}{p.category ? ` • ${p.category}` : ""}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-amber-600">{p.quantity} {p.unit}</p>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-sm text-gray-400">All stock is healthy.</div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-[#162B4D]">Recent Movements</h2>
              <p className="text-xs text-gray-400 mt-0.5">Latest stock changes across sub-hubs.</p>
            </div>
            <div className="divide-y divide-gray-100">
              {loading ? (
                <div className="p-5 space-y-3">
                  <div className="h-12 bg-gray-50 rounded-lg animate-pulse" />
                  <div className="h-12 bg-gray-50 rounded-lg animate-pulse" />
                </div>
              ) : data?.recentMovements.length ? (
                data.recentMovements.map((m, i) => {
                  const positive = (m.change ?? 0) > 0;
                  return (
                    <div key={String(m._id ?? i)} className="p-4 flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${positive ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"}`}>
                        <History className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-sm text-[#162B4D] truncate">{m.productName ?? "Item"}</p>
                          <p className={`font-bold text-sm ${positive ? "text-emerald-600" : "text-red-600"}`}>
                            {positive ? "+" : ""}{m.change ?? 0}
                          </p>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {MOVEMENT_LABELS[m.type] ?? m.type}
                          {m.orderRef ? ` • ${m.orderRef}` : ""}
                          {m.reason ? ` • ${m.reason}` : ""}
                          {m.subHubName ? ` • ${m.subHubName}` : ""}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5">{formatDate(m.createdAt)}</p>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-8 text-center text-sm text-gray-400">No movements recorded.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
