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
    <div className="min-h-screen w-full flex bg-[#F4F6FA]">
      {/* Left brand panel */}
      <div className="hidden lg:flex lg:w-[44%] xl:w-[40%] relative overflow-hidden bg-[#0D1F3C]">
        <div className="absolute inset-0">
          <img src="/bg.jpg" alt="" className="w-full h-full object-cover opacity-25" />
          <div className="absolute inset-0 bg-gradient-to-br from-[#0D1F3C] via-[#0D1F3C]/95 to-[#162B4D]/90" />
        </div>
        <div className="relative z-10 flex flex-col justify-between p-12 w-full text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center">
              <img src="/brand-mark.svg" alt="" className="w-8 h-8 object-contain" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Fresh Stock Xchange</span>
          </div>

          <div className="space-y-4 max-w-md">
            <h2 className="text-3xl xl:text-4xl font-semibold leading-tight">
              Operations console for Fresh Stock Xchange.
            </h2>
            <p className="text-white/60 text-sm leading-relaxed">
              A single workspace to manage hubs, vendors, inventory,
              orders and deliveries across your distribution network.
            </p>
          </div>

          <div className="text-xs text-white/40">
            © {new Date().getFullYear()} Fresh Stock Xchange. All rights reserved.
          </div>
        </div>
      </div>

      {/* Right content */}
      <div className="flex-1 flex items-center justify-center px-6 py-10 relative overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img src="/login-bg.png" alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-white/70 backdrop-blur-[1px]" />
        </div>
        <div className="relative z-10 w-full flex items-center justify-center">
        <div className="w-full max-w-xl">
          {/* Mobile brand */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-lg bg-[#0D1F3C] flex items-center justify-center">
              <img src="/brand-mark.svg" alt="" className="w-7 h-7 object-contain" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-[#0D1F3C]">Fresh Stock Xchange</span>
          </div>

          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-600 mb-2">
              Sign in
            </p>
            <h1 className="text-2xl font-semibold text-[#0D1F3C] tracking-tight">
              Sign in to Fresh Stock Xchange
            </h1>
            <p className="mt-2 text-sm text-gray-700">
              Continue with your administrator account.
            </p>
          </div>

          <div className="space-y-2.5">
            {roles.map(({ key, label, desc, icon: Icon, route }) => (
              <button
                key={key}
                onClick={() => setLocation(route)}
                className="group w-full flex items-center gap-4 p-4 rounded-lg border border-gray-200 bg-white hover:border-[#0D1F3C] hover:shadow-sm transition-all text-left"
              >
                <div className="w-10 h-10 rounded-md bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-600 group-hover:bg-[#0D1F3C] group-hover:text-white group-hover:border-[#0D1F3C] transition-colors">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-[#0D1F3C]">{label}</p>
                  <p className="text-xs text-gray-600 mt-0.5 truncate">{desc}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-[#0D1F3C] group-hover:translate-x-0.5 transition-all" />
              </button>
            ))}
          </div>

          <p className="mt-8 text-xs text-gray-700">
            Need help signing in? Contact your system administrator.
          </p>
        </div>
        </div>
      </div>
    </div>
  );
}
