import { useLocation } from "wouter";
import { ShieldCheck, ArrowRight } from "lucide-react";
import { useEffect } from "react";

const roles = [
  {
    key: "master_admin",
    label: "Master Admin",
    desc: "Full system access across your operations.",
    icon: ShieldCheck,
    route: "/login?role=master_admin",
  },
];

export default function RoleSelect() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    const token = localStorage.getItem("fishtokri_token");
    if (token) {
      const admin = (() => {
        try { return JSON.parse(localStorage.getItem("fishtokri_admin") || "{}"); } catch { return {}; }
      })();
      if (admin?.role === "master_admin") setLocation("/dashboard");
      else {
        localStorage.removeItem("fishtokri_token");
        localStorage.removeItem("fishtokri_admin");
        sessionStorage.removeItem("fishtokri_token");
        sessionStorage.removeItem("fishtokri_admin");
      }
    }
  }, [setLocation]);

  return (
    <div className="min-h-[100dvh] w-full flex bg-[#F4F6FA]">
      {/* Brand panel */}
      <aside className="hidden lg:flex lg:w-[44%] xl:w-[43%] relative overflow-hidden bg-[#F4F7EC] text-[#000035]">
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-[#FBF9F0] via-[#F1F8E9] to-[#E6F3DC]" />
          <div className="absolute -left-28 top-[28%] w-[32rem] h-[32rem] rounded-full bg-[#69D84F]/10 blur-3xl" />
          <div className="absolute -right-32 -bottom-36 w-[34rem] h-[34rem] rounded-full border border-[#3E9F2B]/15" />
          <div className="absolute -right-12 -bottom-16 w-[24rem] h-[24rem] rounded-full border border-[#3E9F2B]/15" />
        </div>
        <div className="relative z-10 flex flex-col justify-between p-12 xl:p-14 w-full">
          <div className="w-full pt-12 text-center">
            <div className="mx-auto w-full max-w-[500px] rounded-2xl border border-white bg-white/95 px-5 py-4 shadow-[0_14px_34px_rgba(0,0,53,0.09)]">
              <img
                src="/fresh-stock-xchange-logo.png"
                alt="Fresh Stock Xchange"
                className="mx-auto block w-full max-w-[430px] h-auto max-h-[74px] object-contain"
              />
            </div>
            <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#52614D]">
              Operations console
            </p>
          </div>

          <div className="space-y-5 max-w-md">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#3E9F2B]/20 bg-white/70 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-[#347F27] shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-[#69D84F]" />
              FRESH FISH. EVERY HUB. IN SYNC.
            </div>
            <h2 className="text-4xl xl:text-[3.35rem] font-semibold leading-[1.06] tracking-tight text-[#000035]">
              Your fish operations,<br />in one clear view.
            </h2>
            <p className="text-[#52614D] text-sm leading-7 max-w-sm">
              Manage hubs, stock, orders and deliveries from one workspace built for your team.
            </p>
            <div className="grid grid-cols-3 gap-5 pt-4 border-t border-[#000035]/10 max-w-sm">
              <div><p className="text-xl font-semibold text-[#000035]">Hubs</p><p className="text-[10px] mt-1 uppercase tracking-wider text-[#687468]">Connected</p></div>
              <div><p className="text-xl font-semibold text-[#000035]">Stock</p><p className="text-[10px] mt-1 uppercase tracking-wider text-[#687468]">In view</p></div>
              <div><p className="text-xl font-semibold text-[#000035]">Orders</p><p className="text-[10px] mt-1 uppercase tracking-wider text-[#687468]">On track</p></div>
            </div>
          </div>

          <div className="text-xs text-[#000035]/45">
            © {new Date().getFullYear()} Fresh Stock Xchange
          </div>
        </div>
      </aside>

      {/* Account selection */}
      <main className="flex-1 flex items-center justify-center px-5 py-8 sm:px-8 sm:py-10 relative overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img src="/login-bg.png" alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-[#F4F6FA]/85 backdrop-blur-[2px]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(105,216,79,0.18),transparent_48%)]" />
        </div>
        <div className="relative z-10 w-full flex items-center justify-center">
          <div className="w-full max-w-[500px] rounded-[1.65rem] border border-white/80 bg-white/90 px-6 py-7 shadow-[0_26px_80px_rgba(0,0,53,0.12)] sm:px-9 sm:py-9">
            {/* Mobile brand */}
            <div className="lg:hidden mb-8">
              <div className="rounded-xl border border-[#000035]/10 bg-white px-4 py-3 shadow-sm">
                <img
                  src="/fresh-stock-xchange-logo.png"
                  alt="Fresh Stock Xchange"
                  className="mx-auto block w-full max-w-[320px] h-auto max-h-12 object-contain"
                />
              </div>
              <p className="mt-2 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-[#687468]">
                Operations console
              </p>
            </div>

            <div className="mb-7">
              <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-[#4A9E38] mb-2.5">
                ADMIN ACCESS
              </p>
              <h1 className="text-[1.8rem] leading-tight font-semibold text-[#000035] tracking-tight">
                Choose your workspace
              </h1>
              <p className="mt-2 text-sm text-[#6D6F80]">
                Continue with your administrator account.
              </p>
            </div>

            <div className="space-y-3">
              {roles.map(({ key, label, desc, icon: Icon, route }) => (
                <button
                  key={key}
                  onClick={() => setLocation(route)}
                  className="group w-full flex items-center gap-4 p-4 rounded-2xl border border-[#D9E0E8] bg-white hover:border-[#69D84F] hover:bg-[#FBFEF8] hover:shadow-[0_12px_28px_rgba(0,0,53,0.09)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#69D84F] focus-visible:ring-offset-2 transition-all text-left"
                  data-testid={`button-role-${key}`}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#EAF5E5] border border-[#D9EED0] flex items-center justify-center text-[#000035] group-hover:bg-[#69D84F] group-hover:border-[#69D84F] transition-colors">
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-[#000035]">{label}</p>
                    <p className="text-xs text-[#6D6F80] mt-1">{desc}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#77798A] group-hover:text-[#000035] group-hover:translate-x-0.5 transition-all" />
                </button>
              ))}
            </div>

            <p className="mt-7 text-xs leading-relaxed text-[#737585]">
              Need help signing in? Contact your system administrator.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
