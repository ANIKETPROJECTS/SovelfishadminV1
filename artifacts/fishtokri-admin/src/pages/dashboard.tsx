import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  useGetStatsSummary,
  getGetStatsSummaryQueryKey,
  useGetSuperHubs,
  getGetSuperHubsQueryKey,
} from "@workspace/api-client-react";
import {
  Building2, MapPin, Users, Layers, TrendingUp, Activity,
  CheckCircle2, AlertCircle, ShoppingBag, Truck, Clock,
  Package, XCircle, RefreshCw, Phone, User, UserCheck,
  ArrowRight, Store, CircleDollarSign,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area, CartesianGrid,
} from "recharts";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem("fishtokri_token") || ""; }
function getBase() { return import.meta.env.BASE_URL?.replace(/\/$/, "") || ""; }

async function apiFetch(path: string) {
  const res = await fetch(`${getBase()}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

function formatRupees(n: number) {
  return `₹${Number(n || 0).toLocaleString("en-IN")}`;
}
function formatDate(d: any) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ─── COLORS ───────────────────────────────────────────────────────────────────
const HUB_COLORS   = ["#1A56DB", "#10B981", "#F59E0B", "#8B5CF6", "#EF4444"];
const ACTIVE_COLOR = "#10B981";
const INACTIVE_COLOR = "#F87171";

const ORDER_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; chart: string; icon: any }> = {
  pending:          { label: "Pending",         color: "text-amber-600",  bg: "bg-amber-50 border-amber-200",  chart: "#F59E0B", icon: Clock },
  confirmed:        { label: "Confirmed",        color: "text-blue-600",   bg: "bg-blue-50 border-blue-200",    chart: "#1A56DB", icon: CheckCircle2 },
  out_for_delivery: { label: "Out for Delivery", color: "text-indigo-600", bg: "bg-indigo-50 border-indigo-200",chart: "#6366F1", icon: Truck },
  delivered:        { label: "Delivered",        color: "text-green-600",  bg: "bg-green-50 border-green-200",  chart: "#10B981", icon: CheckCircle2 },
  cancelled:        { label: "Cancelled",        color: "text-red-500",    bg: "bg-red-50 border-red-200",      chart: "#EF4444", icon: XCircle },
};

// ─── CUSTOM TOOLTIP ───────────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-100 shadow-xl rounded-xl px-3 py-2.5 text-xs">
        <p className="font-bold text-gray-700 mb-1.5">{label}</p>
        {payload.map((p: any) => (
          <p key={p.name} className="flex items-center gap-1.5 font-medium" style={{ color: p.color }}>
            <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
            {p.name}: <span className="text-gray-800 font-bold">{p.value}</span>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({
  title, value, sub, icon: Icon, iconColor, iconBg, border, badge, badgeColor, loading,
}: {
  title: string; value: string | number; sub: string;
  icon: any; iconColor: string; iconBg: string; border: string;
  badge?: string; badgeColor?: string; loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-[108px] rounded-2xl" />;
  return (
    <div className={`bg-white rounded-2xl border ${border} shadow-sm p-5 flex flex-col gap-3`}>
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center flex-shrink-0`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
        {badge && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor ?? "bg-green-50 text-green-600"}`}>
            {badge}
          </span>
        )}
      </div>
      <div>
        <p className="text-2xl font-extrabold text-[#162B4D] leading-none">{value}</p>
        <p className="text-xs font-semibold text-gray-500 mt-1">{title}</p>
        <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>
      </div>
    </div>
  );
}

// ─── SECTION HEADER ───────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, iconColor, title, action, onAction }: any) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${iconColor}`} />
        <h3 className="text-sm font-bold text-[#162B4D]">{title}</h3>
      </div>
      {action && (
        <button onClick={onAction} className="flex items-center gap-1 text-[11px] font-semibold text-[#1A56DB] hover:text-[#1447B4] bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg transition-colors">
          {action} <ArrowRight className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useGetStatsSummary(undefined, {
    query: { queryKey: getGetStatsSummaryQueryKey() },
  });
  const { data: superHubsData, isLoading: hubsLoading, refetch: refetchHubs } = useGetSuperHubs(undefined, {
    query: { queryKey: getGetSuperHubsQueryKey() },
  });

  const [orderStats, setOrderStats]           = useState<Record<string, number>>({});
  const [recentOrders, setRecentOrders]       = useState<any[]>([]);
  const [customers, setCustomers]             = useState<{ total: number }>({ total: 0 });
  const [vendors, setVendors]                 = useState<{ total: number }>({ total: 0 });
  const [deliveryPersons, setDeliveryPersons] = useState<{ total: number }>({ total: 0 });
  const [extraLoading, setExtraLoading]       = useState(true);
  const [airoliSubHubId, setAiroliSubHubId]   = useState("");
  const [airoliLookupLoading, setAiroliLookupLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/sub-hubs")
      .then((data) => {
        const subHubs = Array.isArray(data?.subHubs) ? data.subHubs : [];
        const airoli =
          subHubs.find((sub: any) =>
            String(sub.name ?? "").trim().toLowerCase() === "airoli" && sub.status === "Active"
          ) ??
          subHubs.find((sub: any) => String(sub.name ?? "").trim().toLowerCase() === "airoli");
        if (!cancelled) setAiroliSubHubId(airoli?.id ? String(airoli.id) : "");
      })
      .catch(() => {
        if (!cancelled) setAiroliSubHubId("");
      })
      .finally(() => {
        if (!cancelled) setAiroliLookupLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const loadExtra = useCallback(async (silent = false) => {
    if (!silent) setExtraLoading(true);
    try {
      const [oStats, oRecent, cust, vend, dp] = await Promise.allSettled([
        apiFetch("/api/orders/stats"),
        apiFetch("/api/orders?limit=6&sort=createdAt&order=desc"),
        apiFetch("/api/customers?limit=1"),
        apiFetch("/api/vendors?limit=1"),
        apiFetch("/api/users?role=delivery_person&limit=1"),
      ]);
      if (oStats.status === "fulfilled")   setOrderStats(oStats.value.stats ?? {});
      if (oRecent.status === "fulfilled")  setRecentOrders(oRecent.value.orders ?? []);
      if (cust.status === "fulfilled")     setCustomers({ total: cust.value.total ?? 0 });
      if (vend.status === "fulfilled")     setVendors({ total: vend.value.total ?? 0 });
      if (dp.status === "fulfilled")       setDeliveryPersons({ total: dp.value.total ?? 0 });
    } finally { setExtraLoading(false); }
  }, []);

  useEffect(() => { loadExtra(); }, [loadExtra]);

  useEffect(() => {
    const id = setInterval(() => { loadExtra(true); refetchStats(); refetchHubs(); }, 5000);
    return () => clearInterval(id);
  }, [loadExtra, refetchStats, refetchHubs]);

  const handleRefresh = () => {
    refetchStats();
    refetchHubs();
    loadExtra();
  };

  const handleOpenAiroliMenu = () => {
    if (!airoliSubHubId) return;
    localStorage.setItem("fishtokri_last_subhub_id", airoliSubHubId);
    setLocation(`/sub-hub-menu/${encodeURIComponent(airoliSubHubId)}`);
  };

  const superHubs = superHubsData?.superHubs ?? [];
  const isLoading = statsLoading || hubsLoading;

  // ── Derived order data ───────────────────────────────────────────────────
  const totalOrders    = Object.values(orderStats).reduce((a, b) => a + b, 0);
  const activeOrders   = (orderStats.pending ?? 0) + (orderStats.confirmed ?? 0) + (orderStats.out_for_delivery ?? 0);
  const pendingOrders  = orderStats.pending ?? 0;
  const deliveredCount = orderStats.delivered ?? 0;

  const orderStatusPieData = Object.entries(ORDER_STATUS_CONFIG)
    .map(([key, cfg]) => ({ name: cfg.label, value: orderStats[key] ?? 0, color: cfg.chart }))
    .filter((d) => d.value > 0);

  const orderStatusBarData = Object.entries(ORDER_STATUS_CONFIG).map(([key, cfg]) => ({
    name: cfg.label.replace(" for ", "\nfor "),
    count: orderStats[key] ?? 0,
    color: cfg.chart,
  }));

  // ── Hub bar data ─────────────────────────────────────────────────────────
  const subHubsBarData = superHubs.map((h) => ({ name: h.name, "Sub Hubs": h.subHubCount }));

  const hubStatusData = [
    { name: "Active",   value: stats?.activeSuperHubs ?? 0 },
    { name: "Inactive", value: (stats?.totalSuperHubs ?? 0) - (stats?.activeSuperHubs ?? 0) },
  ].filter((d) => d.value > 0);

  const subHubStatusData = [
    { name: "Active",   value: stats?.activeSubHubs ?? 0 },
    { name: "Inactive", value: (stats?.totalSubHubs ?? 0) - (stats?.activeSubHubs ?? 0) },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-7 max-w-7xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-[#162B4D]">Dashboard</h2>
          <p className="text-gray-400 text-sm mt-0.5">Complete overview of your distribution network</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleOpenAiroliMenu}
            disabled={!airoliSubHubId}
            title={!airoliLookupLoading && !airoliSubHubId ? "Airoli Sub Hub was not found" : undefined}
            className="h-8 gap-1.5 bg-[#1A56DB] hover:bg-[#1447B4] text-white disabled:opacity-60"
          >
            <Store className="w-3.5 h-3.5" />
            {airoliLookupLoading ? "Loading Airoli..." : "Manage Airoli Menu"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} className="h-8 gap-1.5 text-gray-500">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* ── Row 1: Network stats ─────────────────────────────────────────────── */}
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <Building2 className="w-3 h-3" /> Network
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard loading={isLoading} title="Total Super Hubs"   value={stats?.totalSuperHubs ?? 0}   sub={`${stats?.activeSuperHubs ?? 0} active`}          icon={Building2}  iconColor="text-[#1A56DB]"    iconBg="bg-blue-50"   border="border-blue-100"   badge="Network"        badgeColor="bg-blue-50 text-blue-600" />
          <StatCard loading={isLoading} title="Total Sub Hubs"     value={stats?.totalSubHubs ?? 0}     sub={`${stats?.activeSubHubs ?? 0} active`}            icon={Layers}     iconColor="text-green-600"    iconBg="bg-green-50"  border="border-green-100"  badge={`${stats?.totalSubHubs ? Math.round((stats.activeSubHubs / stats.totalSubHubs) * 100) : 0}% active`} badgeColor="bg-green-50 text-green-600" />
          <StatCard loading={isLoading} title="Service Pincodes"   value={stats?.totalPincodes ?? 0}    sub="across all hubs"                                  icon={MapPin}     iconColor="text-purple-600"   iconBg="bg-purple-50" border="border-purple-100" badge="Coverage"       badgeColor="bg-purple-50 text-purple-600" />
          <StatCard loading={isLoading} title="Admin Users"        value={stats?.totalUsers ?? 0}       sub={`${stats?.activeUsers ?? 0} active`}              icon={Users}      iconColor="text-amber-600"    iconBg="bg-amber-50"  border="border-amber-100"  badge={`${stats?.totalUsers ? Math.round((stats.activeUsers / stats.totalUsers) * 100) : 0}% active`} badgeColor="bg-amber-50 text-amber-600" />
        </div>
      </div>

      {/* ── Row 2: Order + people stats ──────────────────────────────────────── */}
      <div>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <ShoppingBag className="w-3 h-3" /> Operations
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard loading={extraLoading} title="Total Orders"       value={totalOrders}              sub={`${activeOrders} active`}                         icon={ShoppingBag} iconColor="text-orange-600"   iconBg="bg-orange-50"  border="border-orange-100"  badge={`${pendingOrders} pending`} badgeColor={pendingOrders > 0 ? "bg-amber-50 text-amber-600" : "bg-gray-50 text-gray-400"} />
          <StatCard loading={extraLoading} title="Delivered Orders"   value={deliveredCount}           sub={`${orderStats.cancelled ?? 0} cancelled`}         icon={CheckCircle2} iconColor="text-green-600"   iconBg="bg-green-50"  border="border-green-100"   badge="Fulfilled"      badgeColor="bg-green-50 text-green-600" />
          <StatCard loading={extraLoading} title="Total Customers"    value={customers.total}          sub="registered accounts"                              icon={User}        iconColor="text-sky-600"      iconBg="bg-sky-50"    border="border-sky-100"     badge="Customers"      badgeColor="bg-sky-50 text-sky-600" />
          <StatCard loading={extraLoading} title="Delivery Partners"  value={deliveryPersons.total}    sub="across all hubs"                                  icon={UserCheck}   iconColor="text-indigo-600"   iconBg="bg-indigo-50" border="border-indigo-100"   badge="Field team"     badgeColor="bg-indigo-50 text-indigo-600" />
        </div>
      </div>

      {/* ── Row 3: Order breakdown + recent orders ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Order status bar chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <SectionHeader icon={ShoppingBag} iconColor="text-orange-500" title="Orders by Status" />
          {extraLoading ? (
            <Skeleton className="h-52 rounded-xl" />
          ) : totalOrders === 0 ? (
            <div className="h-52 flex flex-col items-center justify-center text-gray-300">
              <ShoppingBag className="w-10 h-10 mb-2" />
              <p className="text-sm font-medium">No orders yet</p>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={orderStatusBarData} barSize={28} margin={{ top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="count" name="Orders" radius={[6, 6, 0, 0]}>
                    {orderStatusBarData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Mini legend */}
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-3">
                {orderStatusPieData.map((d) => (
                  <div key={d.name} className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.color }} />
                    <span className="text-[10px] text-gray-500">{d.name}: <strong className="text-gray-700">{d.value}</strong></span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Recent orders table */}
        <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <SectionHeader icon={Clock} iconColor="text-[#1A56DB]" title="Recent Orders" action="View all" onAction={() => window.location.hash = "#/orders"} />
          {extraLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>
          ) : recentOrders.length === 0 ? (
            <div className="h-52 flex flex-col items-center justify-center text-gray-300">
              <Clock className="w-10 h-10 mb-2" />
              <p className="text-sm font-medium">No recent orders</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentOrders.map((o) => {
                const cfg = ORDER_STATUS_CONFIG[o.status];
                const Icon = cfg?.icon ?? Clock;
                const total = (o.items ?? []).reduce((s: number, i: any) => s + Number(i.price || 0) * Number(i.quantity || 1), 0);
                return (
                  <div key={String(o._id)} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/60 transition-colors">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${cfg?.bg ?? "bg-gray-50"}`}>
                      <Icon className={`w-4 h-4 ${cfg?.color ?? "text-gray-400"}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-[#162B4D] truncate">{o.customerName}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${cfg?.bg ?? "bg-gray-50 border-gray-200"} ${cfg?.color ?? "text-gray-500"}`}>
                          {cfg?.label ?? o.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><Phone className="w-2.5 h-2.5" />{o.phone}</span>
                        {o.deliveryArea && <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{o.deliveryArea}</span>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-bold text-[#162B4D]">{formatRupees(total)}</p>
                      <p className="text-[10px] text-gray-400">{formatDate(o.createdAt)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 4: Hub charts ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Sub Hubs per Super Hub bar */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <SectionHeader icon={Activity} iconColor="text-[#1A56DB]" title="Sub Hubs per Super Hub" />
          {hubsLoading ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : subHubsBarData.length === 0 ? (
            <div className="h-48 flex flex-col items-center justify-center text-gray-300">
              <Building2 className="w-10 h-10 mb-2" />
              <p className="text-sm font-medium">No hubs configured</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={subHubsBarData} barSize={44}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#6B7280" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="Sub Hubs" radius={[8, 8, 0, 0]}>
                  {subHubsBarData.map((_, i) => <Cell key={i} fill={HUB_COLORS[i % HUB_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Hub status donuts stacked */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-6">
          {/* Super hub status */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              <h4 className="text-xs font-bold text-[#162B4D]">Super Hub Status</h4>
            </div>
            {statsLoading ? <Skeleton className="h-28 rounded-xl" /> : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width={90} height={90}>
                  <PieChart>
                    <Pie data={hubStatusData} cx="50%" cy="50%" innerRadius={25} outerRadius={40} paddingAngle={4} dataKey="value">
                      {hubStatusData.map((_, i) => <Cell key={i} fill={i === 0 ? ACTIVE_COLOR : INACTIVE_COLOR} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-1.5">
                  {hubStatusData.map((d, i) => (
                    <div key={d.name} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: i === 0 ? ACTIVE_COLOR : INACTIVE_COLOR }} />
                      <span className="text-xs text-gray-500">{d.name}</span>
                      <strong className="text-xs text-gray-800 ml-auto pl-2">{d.value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-100" />

          {/* Sub hub status */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
              <h4 className="text-xs font-bold text-[#162B4D]">Sub Hub Status</h4>
            </div>
            {statsLoading ? <Skeleton className="h-28 rounded-xl" /> : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width={90} height={90}>
                  <PieChart>
                    <Pie data={subHubStatusData} cx="50%" cy="50%" innerRadius={25} outerRadius={40} paddingAngle={4} dataKey="value">
                      {subHubStatusData.map((_, i) => <Cell key={i} fill={i === 0 ? ACTIVE_COLOR : INACTIVE_COLOR} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-1.5">
                  {subHubStatusData.map((d, i) => (
                    <div key={d.name} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: i === 0 ? ACTIVE_COLOR : INACTIVE_COLOR }} />
                      <span className="text-xs text-gray-500">{d.name}</span>
                      <strong className="text-xs text-gray-800 ml-auto pl-2">{d.value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 5: Order pipeline + Hub performance ──────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Order pipeline card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <SectionHeader icon={Truck} iconColor="text-indigo-500" title="Order Pipeline" />
          <div className="space-y-3">
            {[
              { key: "pending",          label: "Pending",         icon: Clock,        color: "text-amber-600",  bg: "bg-amber-50",  bar: "bg-amber-400"  },
              { key: "confirmed",        label: "Confirmed",       icon: CheckCircle2, color: "text-blue-600",   bg: "bg-blue-50",   bar: "bg-blue-500"   },
              { key: "out_for_delivery", label: "Out for Delivery",icon: Truck,        color: "text-indigo-600", bg: "bg-indigo-50", bar: "bg-indigo-500" },
              { key: "delivered",        label: "Delivered",       icon: CheckCircle2, color: "text-green-600",  bg: "bg-green-50",  bar: "bg-green-500"  },
              { key: "cancelled",        label: "Cancelled",       icon: XCircle,      color: "text-red-500",    bg: "bg-red-50",    bar: "bg-red-400"    },
            ].map(({ key, label, icon: Icon, color, bg, bar }) => {
              const count = orderStats[key] ?? 0;
              const pct   = totalOrders > 0 ? Math.round((count / totalOrders) * 100) : 0;
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon className={`w-3.5 h-3.5 ${color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-700">{label}</span>
                      <span className={`text-xs font-bold ${color}`}>{count}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full ${bar} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="text-[10px] text-gray-400 w-7 text-right">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Hub performance table */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <SectionHeader icon={Building2} iconColor="text-[#1A56DB]" title="Hub Performance" />
          {hubsLoading ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : superHubs.length === 0 ? (
            <div className="h-48 flex flex-col items-center justify-center text-gray-300">
              <Building2 className="w-10 h-10 mb-2" />
              <p className="text-sm font-medium">No super hubs yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {superHubs.map((hub, idx) => {
                const pct = stats?.totalSubHubs ? Math.round((hub.subHubCount / stats.totalSubHubs) * 100) : 0;
                return (
                  <div key={hub.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50/60 transition-colors">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 font-bold text-white text-sm" style={{ background: HUB_COLORS[idx % HUB_COLORS.length] }}>
                      {hub.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-[#162B4D] truncate">{hub.name}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-2 flex-shrink-0 ${hub.status === "Active" ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"}`}>
                          {hub.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        {hub.location && <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{hub.location}</span>}
                        <span className="text-[10px] text-blue-600 font-semibold bg-blue-50 px-1.5 py-0.5 rounded-full">{hub.subHubCount} sub-hub{hub.subHubCount !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: HUB_COLORS[idx % HUB_COLORS.length] }} />
                        </div>
                        <span className="text-[10px] text-gray-400 w-7">{pct}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 6: Quick numbers strip ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Vendors",           value: vendors.total,          icon: Store,            color: "text-rose-500",    bg: "bg-rose-50",    loading: extraLoading },
          { label: "Delivery Partners", value: deliveryPersons.total,  icon: Truck,            color: "text-indigo-500",  bg: "bg-indigo-50",  loading: extraLoading },
          { label: "Out for Delivery",  value: orderStats.out_for_delivery ?? 0, icon: Truck,  color: "text-blue-500",    bg: "bg-blue-50",    loading: extraLoading },
          { label: "Pincodes Covered",  value: stats?.totalPincodes ?? 0, icon: MapPin,         color: "text-purple-500",  bg: "bg-purple-50",  loading: isLoading },
        ].map(({ label, value, icon: Icon, color, bg, loading }) =>
          loading ? <Skeleton key={label} className="h-20 rounded-2xl" /> : (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0`}>
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
              <div>
                <p className="text-xl font-extrabold text-[#162B4D]">{value}</p>
                <p className="text-[11px] text-gray-400 font-medium">{label}</p>
              </div>
            </div>
          )
        )}
      </div>

    </div>
  );
}
