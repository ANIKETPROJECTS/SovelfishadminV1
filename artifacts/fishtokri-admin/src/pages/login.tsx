import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const REMEMBER_EMAIL_KEY = "fishtokri_remembered_email";

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const loginMutation = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Forgot password modal
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotNote, setForgotNote] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);

  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBER_EMAIL_KEY);
    if (remembered) {
      setEmail(remembered);
      setRememberMe(true);
    }
  }, []);

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

  const roleLabel = "Master Admin";

  const persistAuth = (token: string, admin: any) => {
    const adminJson = JSON.stringify(admin);
    if (rememberMe) {
      // Long-lived: localStorage only, plus remember email.
      localStorage.setItem("fishtokri_token", token);
      localStorage.setItem("fishtokri_admin", adminJson);
      localStorage.setItem(REMEMBER_EMAIL_KEY, email);
      sessionStorage.removeItem("fishtokri_token");
      sessionStorage.removeItem("fishtokri_admin");
    } else {
      // Session-only: sessionStorage is the source of truth; we mirror to
      // localStorage so the rest of the app keeps working, then a beforeunload
      // handler in main.tsx clears localStorage on tab close.
      sessionStorage.setItem("fishtokri_token", token);
      sessionStorage.setItem("fishtokri_admin", adminJson);
      localStorage.setItem("fishtokri_token", token);
      localStorage.setItem("fishtokri_admin", adminJson);
      localStorage.removeItem(REMEMBER_EMAIL_KEY);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    loginMutation.mutate(
      { data: { email, password } },
      {
        onSuccess: (data) => {
          persistAuth(data.token, data.admin);
          setLocation("/dashboard");
        },
        onError: (err: any) => {
          setError(err?.response?.data?.message || "Invalid credentials. Please check your email and password.");
        }
      }
    );
  };

  const openForgot = () => {
    setForgotEmail(email);
    setForgotNote("");
    setForgotOpen(true);
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail) return;
    setForgotSubmitting(true);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const res = await fetch(`${base}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim().toLowerCase(), note: forgotNote.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Could not submit request");
      toast({
        title: "Request submitted",
        description: "If the account exists, your master admin has been notified to reset the password.",
      });
      setForgotOpen(false);
    } catch (err: any) {
      toast({ title: "Could not submit", description: err.message, variant: "destructive" });
    } finally {
      setForgotSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex bg-[#F4F6FA]">
      {/* Left brand panel */}
      <div className="hidden lg:flex lg:w-[44%] xl:w-[43%] relative overflow-hidden bg-[#000035]">
        <div className="absolute inset-0">
          <img src="/bg.jpg" alt="" className="w-full h-full object-cover opacity-20" />
          <div className="absolute inset-0 bg-gradient-to-br from-[#000035]/95 via-[#000035]/90 to-[#12124A]/95" />
          <div className="absolute -right-28 -bottom-32 w-[34rem] h-[34rem] rounded-full border border-[#69D84F]/20" />
          <div className="absolute -right-10 -bottom-14 w-[24rem] h-[24rem] rounded-full border border-[#69D84F]/20" />
        </div>
        <div className="relative z-10 flex flex-col justify-between p-12 xl:p-14 w-full text-white">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#69D84F] flex items-center justify-center shadow-lg shadow-black/20">
              <img src="/brand-mark.svg" alt="" className="w-8 h-8 object-contain" />
            </div>
            <div>
              <span className="block text-lg font-bold tracking-tight">Fresh Stock Xchange</span>
              <span className="block text-[10px] uppercase tracking-[0.2em] text-white/55">Operations console</span>
            </div>
          </div>

          <div className="space-y-5 max-w-md">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#69D84F]/30 bg-[#69D84F]/10 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-[#A3F08F]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#69D84F]" />
              FRESH FISH. EVERY HUB. IN SYNC.
            </div>
            <h2 className="text-4xl xl:text-[3.35rem] font-semibold leading-[1.06] tracking-tight">
              The day starts<br />with a better <span className="text-[#69D84F]">catch.</span>
            </h2>
            <p className="text-white/65 text-sm leading-7 max-w-sm">
              Keep hubs, stock, orders and deliveries moving together from one clear operations desk.
            </p>
            <div className="grid grid-cols-3 gap-5 pt-4 border-t border-white/10 max-w-sm">
              <div><p className="text-xl font-semibold text-white">Hubs</p><p className="text-[10px] mt-1 uppercase tracking-wider text-white/45">Connected</p></div>
              <div><p className="text-xl font-semibold text-white">Stock</p><p className="text-[10px] mt-1 uppercase tracking-wider text-white/45">In view</p></div>
              <div><p className="text-xl font-semibold text-white">Orders</p><p className="text-[10px] mt-1 uppercase tracking-wider text-white/45">On track</p></div>
            </div>
          </div>

          <div className="text-xs text-white/40">
            © {new Date().getFullYear()} Fresh Stock Xchange
          </div>
        </div>
      </div>

      {/* Right form */}
      <div className="flex-1 flex items-center justify-center px-5 py-8 sm:px-8 sm:py-10 relative overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img src="/login-bg.png" alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-[#F4F6FA]/85 backdrop-blur-[2px]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(105,216,79,0.18),transparent_48%)]" />
        </div>
        <div className="relative z-10 w-full flex items-center justify-center">
        <div className="w-full max-w-[430px] rounded-[1.65rem] border border-white/80 bg-white/90 px-6 py-7 shadow-[0_26px_80px_rgba(0,0,53,0.12)] sm:px-9 sm:py-9">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1.5 text-[#54566B] hover:text-[#000035] text-xs mb-8 transition-colors font-semibold"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to sign in
          </button>

          {/* Mobile brand */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-[#69D84F] flex items-center justify-center">
              <img src="/brand-mark.svg" alt="" className="w-7 h-7 object-contain" />
            </div>
            <div><span className="block text-lg font-bold tracking-tight text-[#000035]">Fresh Stock Xchange</span><span className="block text-[9px] uppercase tracking-[0.18em] text-[#77798A]">Operations console</span></div>
          </div>

          <div className="mb-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-[#4A9E38] mb-2.5">
              STAFF ACCESS
            </p>
            <h1 className="text-[1.8rem] leading-tight font-semibold text-[#000035] tracking-tight" data-testid="login-heading">
              Good to have you back.
            </h1>
            <p className="mt-2 text-sm text-[#6D6F80]">Sign in to manage today’s fish operations.</p>
            <div className="mt-4 inline-flex items-center gap-2 bg-[#F0FBEA] border border-[#DDF5D3] rounded-full px-3 py-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#347F27]" />
              <span className="text-xs font-semibold text-[#245C1D]">{roleLabel}</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label className="text-[#282A43] font-semibold text-xs">Email address</Label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-[#FBFCFA] border-[#D9DCE3] text-[#000035] focus-visible:ring-2 focus-visible:ring-[#69D84F]/50 focus-visible:border-[#59B842] h-11 rounded-xl placeholder:text-[#A0A2AD]"
                data-testid="input-email"
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-[#282A43] font-semibold text-xs">Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-[#FBFCFA] border-[#D9DCE3] text-[#000035] focus-visible:ring-2 focus-visible:ring-[#69D84F]/50 focus-visible:border-[#59B842] h-11 rounded-xl placeholder:text-[#A0A2AD] pr-10"
                  data-testid="input-password"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#888A98] hover:text-[#000035]"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-[#B8BBC6] accent-[#000035] focus:ring-[#69D84F]/40"
                />
                <span className="text-xs text-[#626475]">Remember me</span>
              </label>
              <button
                type="button"
                onClick={openForgot}
                className="text-xs text-[#000035] hover:text-[#397B2E] hover:underline font-semibold"
              >
                Forgot password?
              </button>
            </div>

            {error && (
              <p className="text-red-600 text-xs font-medium bg-red-50 border border-red-200 px-3 py-2 rounded-md" data-testid="text-error">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full h-12 mt-1 bg-[#000035] hover:bg-[#17174D] text-white font-semibold text-sm transition-all rounded-xl shadow-[0_8px_18px_rgba(0,0,53,0.18)]"
              disabled={loginMutation.isPending}
              data-testid="button-login"
            >
              {loginMutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="mt-7 text-xs leading-relaxed text-[#737585]">
            Need help signing in? Contact your system administrator.
          </p>
        </div>
        </div>
      </div>

      {/* Forgot password dialog */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription>
              Enter your account email and your master admin will set a new password for you.
                <span className="block mt-2 text-[#4A6B3D]">
                Master Admin credentials are managed by your system administrator. Contact them if you need help.
              </span>
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitForgot} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-gray-700 font-medium text-xs">Email address</Label>
              <Input
                type="email"
                required
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-11 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-gray-700 font-medium text-xs">Note for your admin (optional)</Label>
              <Input
                type="text"
                value={forgotNote}
                onChange={(e) => setForgotNote(e.target.value)}
                placeholder="e.g. Forgot my password after vacation"
                className="h-11 rounded-xl"
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="ghost" onClick={() => setForgotOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={forgotSubmitting || !forgotEmail}
                className="bg-[#000035] hover:bg-[#17174D] text-white"
              >
                {forgotSubmitting ? "Submitting…" : "Send request"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
