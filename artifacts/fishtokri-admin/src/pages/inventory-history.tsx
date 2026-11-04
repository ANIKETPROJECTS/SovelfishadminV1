import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, Search, History, ArrowDownCircle, ArrowUpCircle, SlidersHorizontal, ChevronRight, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PaginationBar } from "@/components/pagination-bar";
import { usePaginated } from "@/hooks/use-paginated";
import { getCurrentAdminScope } from "@/lib/api";

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

type SuperHub = { id: string; name: string; location?: string };
type SubHub = { id: string; name: string; location?: string };
type Movement = {
  _id: string;
  type: "order_deduct" | "order_restore" | "adjustment";
  productId: string;
  productName: string;
  unit?: string;
  change: number;
  balance: number;
  orderId?: string;
  orderRef?: string;
  invoiceId?: string;
  customerName?: string;
  batchNumbers?: string;
  subReason?: string;
  reason?: string;
  notes?: string;
  createdAt: string;
};

type DatePreset = "all" | "today" | "last7" | "last30" | "custom";
type MovementSort = "newest" | "oldest" | "product_asc" | "decrease" | "increase";

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toLocalDateInputValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateInputToLocalStart(value: string) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function getDateBounds(preset: DatePreset, fromDate: string, toDate: string) {
  if (preset === "all") return {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfToday = new Date(today);
  endOfToday.setDate(endOfToday.getDate() + 1);

  if (preset === "today") {
    return { from: today.toISOString(), to: endOfToday.toISOString() };
  }
  if (preset === "last7" || preset === "last30") {
    const from = new Date(today);
    from.setDate(from.getDate() - (preset === "last7" ? 6 : 29));
    return { from: from.toISOString(), to: endOfToday.toISOString() };
  }

  const from = dateInputToLocalStart(fromDate);
  const to = dateInputToLocalStart(toDate);
  if (to) to.setDate(to.getDate() + 1);
  return {
    ...(from ? { from: from.toISOString() } : {}),
    ...(to ? { to: to.toISOString() } : {}),
  };
}

type SubReasonMeta = { label: string; tone: string };

function getSubReasonMeta(m: Movement): SubReasonMeta | null {
  if (m.type === "adjustment") {
    return { label: "Manual Adjustment", tone: "bg-blue-50 text-blue-700" };
  }
  if (m.type === "order_deduct" || m.type === "order_restore") {
    switch (m.subReason) {
      case "order_placed":
        return { label: "Order Deduction", tone: "bg-red-50 text-red-700" };
      case "order_cancelled":
        return { label: "Order Cancelled", tone: "bg-emerald-50 text-emerald-700" };
      case "order_deleted":
        return { label: "Order Deleted", tone: "bg-orange-50 text-orange-700" };
      case "order_restored":
        return { label: "Deleted Order Restored", tone: "bg-emerald-50 text-emerald-700" };
      case "items_changed":
        return m.type === "order_restore"
          ? { label: "Items Changed", tone: "bg-emerald-50 text-emerald-700" }
          : { label: "Items Changed", tone: "bg-amber-50 text-amber-700" };
      default:
        return m.type === "order_deduct"
          ? { label: "Order Deduction", tone: "bg-red-50 text-red-700" }
          : { label: "Order Restore", tone: "bg-emerald-50 text-emerald-700" };
    }
  }
  return null;
}

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

export default function InventoryHistory() {
  const { toast } = useToast();
  const [superHubs, setSuperHubs] = useState<SuperHub[]>([]);
  const [subHubs, setSubHubs] = useState<SubHub[]>([]);
  const [selectedSuperHubId, setSelectedSuperHubId] = useState("");
  const [selectedSubHubId, setSelectedSubHubId] = useState("");
  const [selectedSuperHub, setSelectedSuperHub] = useState<SuperHub | null>(null);
  const [selectedSubHub, setSelectedSubHub] = useState<SubHub | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<MovementSort>("newest");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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

  const dateBounds = useMemo(
    () => getDateBounds(datePreset, fromDate, toDate),
    [datePreset, fromDate, toDate],
  );

  useEffect(() => {
    if (!selectedSubHubId) {
      setMovements([]);
      setLoading(false);
      return;
    }

    let isCurrentRequest = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        subHubId: selectedSubHubId,
        limit: "2000",
        sortBy,
      });
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (search.trim()) params.set("search", search.trim());
      if (dateBounds.from) params.set("from", dateBounds.from);
      if (dateBounds.to) params.set("to", dateBounds.to);

      apiFetch(`/api/inventory/movements?${params.toString()}`)
        .then((d) => {
          if (isCurrentRequest) setMovements(d.movements ?? []);
        })
        .catch((err) => {
          if (isCurrentRequest) {
            toast({ title: "Failed to load history", description: err.message, variant: "destructive" });
          }
        })
        .finally(() => {
          if (isCurrentRequest) setLoading(false);
        });
    }, search.trim() ? 250 : 0);

    return () => {
      isCurrentRequest = false;
      window.clearTimeout(timer);
    };
  }, [selectedSubHubId, typeFilter, sortBy, search, dateBounds.from, dateBounds.to, toast]);

  const pagedMovements = usePaginated(
    movements,
    20,
    `${search}|${typeFilter}|${sortBy}|${datePreset}|${fromDate}|${toDate}`,
  );

  const hasActiveFilters =
    search.trim().length > 0 ||
    typeFilter !== "all" ||
    sortBy !== "newest" ||
    datePreset !== "all";
  const hasResultFilters =
    search.trim().length > 0 ||
    typeFilter !== "all" ||
    datePreset !== "all";

  const headerSlot = document.getElementById("page-header-slot");
  const headerContent = (
    <div className="flex items-center justify-between w-full gap-4 min-w-0">
      <div className="min-w-0 flex-shrink-0">
        <p className="text-sm font-bold text-[#162B4D] leading-tight">Inventory History</p>
        <p className="text-[11px] text-gray-400 leading-tight hidden sm:block">Stock movement log — order deductions, cancellations, and adjustments.</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {selectedSuperHub && (
          <LockedHubBadge label="Super Hub" name={selectedSuperHub.name} location={selectedSuperHub.location} />
        )}
        {selectedSuperHub && selectedSubHub && (
          <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
        )}
        {selectedSubHub && (
          <LockedHubBadge label="Sub Hub" name={selectedSubHub.name} location={selectedSubHub.location} />
        )}
        <div className="hidden">
          <Select value={selectedSuperHubId} onValueChange={setSelectedSuperHubId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {superHubs.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={selectedSubHubId} onValueChange={setSelectedSubHubId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {subHubs.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {headerSlot && createPortal(headerContent, headerSlot)}

      <div className="space-y-5">
        {!selectedSubHubId ? (
          <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-blue-50 flex items-center justify-center">
              <History className="w-5 h-5 text-[#1A56DB]" />
            </div>
            <p className="text-sm font-semibold text-[#162B4D]">Loading hub data...</p>
            <p className="text-xs text-gray-400 mt-1">Connecting to Mumbai · Airoli inventory history.</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_190px_190px] gap-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <Input
                    data-testid="input-history-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search product, order ID, customer name, phone, or reason..."
                    className="pl-9 h-10"
                  />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger data-testid="select-history-type" className="h-10 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All movements</SelectItem>
                    <SelectItem value="order_deduct">Order deductions</SelectItem>
                    <SelectItem value="order_restore">Order restores</SelectItem>
                    <SelectItem value="adjustment">Manual adjustments</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(value) => setSortBy(value as MovementSort)}>
                  <SelectTrigger data-testid="select-history-sort" className="h-10 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                    <SelectItem value="product_asc">Product A–Z</SelectItem>
                    <SelectItem value="decrease">Largest decrease</SelectItem>
                    <SelectItem value="increase">Largest increase</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div className="w-full sm:w-52">
                  <label htmlFor="history-date-preset" className="block mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date range</label>
                  <Select
                    value={datePreset}
                    onValueChange={(value) => {
                      const preset = value as DatePreset;
                      setDatePreset(preset);
                      if (preset === "custom" && !fromDate && !toDate) {
                        const today = toLocalDateInputValue(new Date());
                        setFromDate(today);
                        setToDate(today);
                      }
                    }}
                  >
                    <SelectTrigger id="history-date-preset" data-testid="select-history-date-range" className="h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All time</SelectItem>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="last7">Last 7 days</SelectItem>
                      <SelectItem value="last30">Last 30 days</SelectItem>
                      <SelectItem value="custom">Custom range</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {datePreset === "custom" && (
                  <>
                    <div className="w-full sm:w-44">
                      <label htmlFor="history-from-date" className="block mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
                      <Input
                        id="history-from-date"
                        data-testid="input-history-from-date"
                        type="date"
                        value={fromDate}
                        max={toDate || undefined}
                        onChange={(e) => setFromDate(e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="w-full sm:w-44">
                      <label htmlFor="history-to-date" className="block mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
                      <Input
                        id="history-to-date"
                        data-testid="input-history-to-date"
                        type="date"
                        value={toDate}
                        min={fromDate || undefined}
                        onChange={(e) => setToDate(e.target.value)}
                        className="h-9"
                      />
                    </div>
                  </>
                )}

                <button
                  type="button"
                  data-testid="button-history-clear-filters"
                  disabled={!hasActiveFilters}
                  onClick={() => {
                    setSearch("");
                    setTypeFilter("all");
                    setSortBy("newest");
                    setDatePreset("all");
                    setFromDate("");
                    setToDate("");
                  }}
                  className="sm:ml-auto h-9 px-3 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Clear filters
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">When</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Order</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Batch</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Change</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading ? (
                      <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">Loading...</td></tr>
                    ) : pagedMovements.total === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">{hasResultFilters ? "No movements match these filters." : "No movements yet"}</td></tr>
                    ) : pagedMovements.pageItems.map((m) => {
                      const isPositive = m.change >= 0;
                      const typeMeta = m.type === "order_deduct"
                        ? { label: "Order Deduct", icon: <ArrowDownCircle className="w-3.5 h-3.5" />, tone: "bg-red-50 text-red-700" }
                        : m.type === "order_restore"
                          ? { label: "Order Restore", icon: <ArrowUpCircle className="w-3.5 h-3.5" />, tone: "bg-emerald-50 text-emerald-700" }
                          : { label: "Adjustment", icon: <SlidersHorizontal className="w-3.5 h-3.5" />, tone: "bg-blue-50 text-blue-700" };
                      const reasonMeta = getSubReasonMeta(m);
                      return (
                        <tr key={m._id} className="hover:bg-gray-50/40">
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDateTime(m.createdAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold w-fit ${typeMeta.tone}`}>
                                {typeMeta.icon}{typeMeta.label}
                              </span>
                              {m.subReason === "items_changed" && (
                                <span className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide">Due to Order Edit</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-[#162B4D]">{m.productName}</p>
                            {m.unit && <p className="text-[11px] text-gray-400">{m.unit}</p>}
                          </td>
                          <td className="px-4 py-3 min-w-[220px]">
                            {m.orderRef ? (
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs font-bold text-[#364F9F] bg-blue-50 px-2 py-0.5 rounded-md">
                                    {m.invoiceId ?? m.orderRef}
                                  </span>
                                  {reasonMeta && (
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${reasonMeta.tone}`}>
                                      {reasonMeta.label}
                                    </span>
                                  )}
                                </div>
                                {m.customerName && (
                                  <p className="text-xs text-gray-600 font-medium">{m.customerName}</p>
                                )}
                              </div>
                            ) : m.type === "adjustment" ? (
                              <div className="flex flex-col gap-1">
                                {reasonMeta && (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold w-fit ${reasonMeta.tone}`}>
                                    {reasonMeta.label}
                                  </span>
                                )}
                                {m.reason && <p className="text-xs font-medium text-[#162B4D]">{m.reason}</p>}
                                {m.notes && <p className="text-[11px] text-gray-400">{m.notes}</p>}
                              </div>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {m.batchNumbers ? (
                              <span className="font-mono text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-md font-medium">
                                {m.batchNumbers}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className={`px-4 py-3 text-right font-semibold ${isPositive ? "text-emerald-600" : "text-red-600"}`}>
                            {isPositive ? "+" : ""}{m.change}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700">{m.balance}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <PaginationBar
                page={pagedMovements.page}
                pages={pagedMovements.pages}
                total={pagedMovements.total}
                onChange={pagedMovements.setPage}
                label="movements"
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
