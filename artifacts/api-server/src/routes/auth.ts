import { Router, type IRouter } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { HubUser } from "../db/models/hub-user.js";
import { PasswordResetRequest } from "../db/models/password-reset-request.js";
import { requireAuth, requireMasterAdmin, type AuthenticatedRequest } from "../middlewares/auth.js";

const router: IRouter = Router();

const ADMIN_EMAIL = "admin@fishtokri.com";
const ADMIN_PASSWORD = "FishTokri@Admin2024";
const JWT_SECRET = process.env.SESSION_SECRET;

if (!JWT_SECRET) {
  throw new Error("SESSION_SECRET must be set.");
}

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  loginRole: z.literal("master_admin").optional(),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const requestedRole =
      typeof req.body === "object" && req.body
        ? (req.body as Record<string, unknown>).loginRole
        : undefined;
    if (requestedRole !== undefined && requestedRole !== "master_admin") {
      res.status(403).json({ error: "Forbidden", message: "Only Master Admin sign-in is available." });
      return;
    }
    res.status(400).json({ error: "ValidationError", message: "Email and password are required" });
    return;
  }

  const { email, password } = parsed.data;

  // Master Admin portal: credentials come from environment secrets.
  {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      res.status(503).json({ error: "NotConfigured", message: "Master admin credentials are not configured. Set MASTER_ADMIN_EMAIL and MASTER_ADMIN_PASSWORD." });
      return;
    }
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
      return;
    }
    const admin = { id: "master-admin-1", email: ADMIN_EMAIL, name: "Master Admin", role: "master_admin" };
    const token = jwt.sign({ adminId: admin.id, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, admin });
    return;
  }

});

// ─── Forgot Password ────────────────────────────────────────────────
const forgotSchema = z.object({
  email: z.string().email().max(200),
  note: z.string().max(500).optional(),
});

router.post("/forgot-password", async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ValidationError", message: "A valid email is required" });
    return;
  }
  const email = parsed.data.email.toLowerCase().trim();
  const note = parsed.data.note?.trim() || "";

  try {
    // Master admin email → no DB record; just respond generic.
    if (email === ADMIN_EMAIL) {
      res.json({ ok: true, message: "If the account exists, your administrator has been notified." });
      return;
    }

    const user = await HubUser.findOne({ email });

    // Always return generic success (no email enumeration), but only create
    // a request when a real user exists.
    if (user) {
      // Avoid duplicating an existing pending request for the same email.
      const existing = await PasswordResetRequest.findOne({ email, status: "pending" });
      if (!existing) {
        await PasswordResetRequest.create({
          email,
          hubUserId: user._id,
          name: user.name || "",
          role: user.role || "",
          note,
          status: "pending",
        });
      } else if (note) {
        existing.note = note;
        await existing.save();
      }
    }

    res.json({ ok: true, message: "If the account exists, your administrator has been notified." });
  } catch {
    res.status(500).json({ error: "InternalError", message: "Could not submit request" });
  }
});

// ─── Master-Admin Password Reset Inbox ─────────────────────────────
router.get("/password-reset-requests", requireAuth as any, requireMasterAdmin as any, async (_req, res) => {
  try {
    const requests = await PasswordResetRequest.find({}).sort({ createdAt: -1 }).limit(200).lean();
    res.json({
      requests: requests.map((r: any) => ({
        id: String(r._id),
        email: r.email,
        name: r.name || "",
        role: r.role || "",
        note: r.note || "",
        status: r.status,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        resolvedByEmail: r.resolvedByEmail || "",
      })),
    });
  } catch {
    res.status(500).json({ error: "InternalError", message: "Could not load requests" });
  }
});

const resolveSchema = z.object({
  newPassword: z.string().min(6).max(200),
});

router.post(
  "/password-reset-requests/:id/resolve",
  requireAuth as any,
  requireMasterAdmin as any,
  async (req: AuthenticatedRequest, res) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", message: "Password must be at least 6 characters" });
      return;
    }
    try {
      const request = await PasswordResetRequest.findById(req.params.id);
      if (!request) {
        res.status(404).json({ error: "NotFound", message: "Request not found" });
        return;
      }
      const user = await HubUser.findOne({ email: request.email });
      if (!user) {
        res.status(404).json({ error: "NotFound", message: "User no longer exists" });
        return;
      }
      user.password = await bcrypt.hash(parsed.data.newPassword, 10);
      await user.save();
      request.status = "resolved";
      request.resolvedAt = new Date();
      request.resolvedByEmail = req.admin?.email || "";
      await request.save();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "InternalError", message: "Could not reset password" });
    }
  }
);

router.post(
  "/password-reset-requests/:id/reject",
  requireAuth as any,
  requireMasterAdmin as any,
  async (req: AuthenticatedRequest, res) => {
    try {
      const request = await PasswordResetRequest.findById(req.params.id);
      if (!request) {
        res.status(404).json({ error: "NotFound", message: "Request not found" });
        return;
      }
      request.status = "rejected";
      request.resolvedAt = new Date();
      request.resolvedByEmail = req.admin?.email || "";
      await request.save();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "InternalError", message: "Could not update request" });
    }
  }
);

router.delete(
  "/password-reset-requests/:id",
  requireAuth as any,
  requireMasterAdmin as any,
  async (req, res) => {
    try {
      await PasswordResetRequest.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "InternalError", message: "Could not delete request" });
    }
  }
);

export default router;
