import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { HubUser } from "../db/models/hub-user.js";
import { SuperHub } from "../db/models/super-hub.js";
import { SubHub } from "../db/models/sub-hub.js";
import { requireAuth } from "../middlewares/auth.js";
import { denyIfNotMaster, loadScope } from "../middlewares/scope.js";

const router: IRouter = Router();
router.use(requireAuth as any);
router.use(loadScope as any);
// User administration is restricted to the Master Admin only.
router.use(denyIfNotMaster as any);

const PHONE_REGEX = /^\d{10}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE_USER_ROLES = new Set(["super_admin", "super_hub", "sub_hub"]);
const LEGACY_DELIVERY_PERSON_ROLE = "delivery_person";

async function enrichUser(user: any) {
  const ids: string[] = Array.isArray(user.superHubIds) && user.superHubIds.length > 0
    ? user.superHubIds.map((id: any) => String(id))
    : user.superHubId ? [String(user.superHubId)] : [];

  const superHubs = ids.length > 0 ? await SuperHub.find({ _id: { $in: ids } }) : [];
  const superHubNames = superHubs.map((s) => s.name);

  const subIds: string[] = Array.isArray((user as any).subHubIds) && (user as any).subHubIds.length > 0
    ? (user as any).subHubIds.map((id: any) => String(id))
    : user.subHubId ? [String(user.subHubId)] : [];

  const subHubs = subIds.length > 0 ? await SubHub.find({ _id: { $in: subIds } }) : [];
  const subHubNames = subHubs.map((s) => s.name);

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    profileImageUrl: user.profileImageUrl ?? "",
    role: user.role,
    superHubId: ids[0] ?? null,
    superHubIds: ids,
    superHubName: superHubNames[0] ?? null,
    superHubNames,
    subHubId: subIds[0] ?? null,
    subHubIds: subIds,
    subHubName: subHubNames[0] ?? null,
    subHubNames,
    status: user.status,
    createdAt: user.createdAt,
  };
}

router.get("/", async (req, res) => {
  try {
    const roleFilter = req.query.role as string | undefined;
    const superHubIdFilter = req.query.superHubId as string | undefined;
    const subHubIdFilter = req.query.subHubId as string | undefined;
    const filter: Record<string, any> = {};
    if (roleFilter) filter.role = roleFilter;
    if (superHubIdFilter) filter.$or = [{ superHubId: superHubIdFilter }, { superHubIds: superHubIdFilter }];
    if (subHubIdFilter) {
      const subConditions = [{ subHubId: subHubIdFilter }, { subHubIds: subHubIdFilter }];
      filter.$or = filter.$or ? [...filter.$or, ...subConditions] : subConditions;
    }
    const users = await HubUser.find(filter).sort({ createdAt: 1 });
    const enriched = await Promise.all(users.map(enrichUser));
    res.json({ users: enriched, total: enriched.length });
  } catch (err) {
    req.log.error({ err }, "Failed to get users");
    res.status(500).json({ error: "InternalError", message: "Failed to fetch users" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, email, phone, profileImageUrl, role, superHubId, superHubIds, subHubId, subHubIds, status, password } = req.body;
    const requestedRole = role ?? "sub_hub";

    if (!name || !email) {
      res.status(400).json({ error: "ValidationError", message: "Name and email are required" });
      return;
    }
    if (!ASSIGNABLE_USER_ROLES.has(String(requestedRole))) {
      res.status(400).json({ error: "ValidationError", message: "Choose Master Admin, Super Hub Admin, or Sub Hub Admin. Delivery Person is no longer assignable." });
      return;
    }
    if (!EMAIL_REGEX.test(email)) {
      res.status(400).json({ error: "ValidationError", message: "Invalid email format" });
      return;
    }
    if (phone && phone.trim() !== "" && !PHONE_REGEX.test(phone.trim())) {
      res.status(400).json({ error: "ValidationError", message: "Phone number must be exactly 10 digits" });
      return;
    }
    if (!password) {
      res.status(400).json({ error: "ValidationError", message: "Password is required" });
      return;
    }

    const emailExists = await HubUser.findOne({ email: email.toLowerCase().trim() });
    if (emailExists) {
      res.status(400).json({ error: "DuplicateEmail", message: "A user with this email already exists" });
      return;
    }

    if (phone && phone.trim() !== "") {
      const phoneExists = await HubUser.findOne({ phone: phone.trim() });
      if (phoneExists) {
        res.status(400).json({ error: "DuplicatePhone", message: "A user with this phone number already exists" });
        return;
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const resolvedSuperHubIds: string[] = Array.isArray(superHubIds) && superHubIds.length > 0 ? superHubIds : superHubId ? [superHubId] : [];
    const resolvedSubHubIds: string[] = Array.isArray(subHubIds) && subHubIds.length > 0 ? subHubIds : subHubId ? [subHubId] : [];

    const user = await HubUser.create({
      name,
      email: email.toLowerCase().trim(),
      phone: phone?.trim() ?? "",
      profileImageUrl: profileImageUrl ?? "",
      role: requestedRole,
      password: hashedPassword,
      superHubId: resolvedSuperHubIds[0] || null,
      superHubIds: resolvedSuperHubIds,
      subHubId: resolvedSubHubIds[0] || null,
      subHubIds: resolvedSubHubIds,
      status: status ?? "Active",
    });
    const enriched = await enrichUser(user);
    res.status(201).json({ user: enriched });
  } catch (err: any) {
    if (err.code === 11000) {
      res.status(400).json({ error: "DuplicateEmail", message: "A user with this email already exists" });
      return;
    }
    req.log.error({ err }, "Failed to create user");
    res.status(500).json({ error: "InternalError", message: "Failed to create user" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const user = await HubUser.findById(req.params.id);
    if (!user) { res.status(404).json({ error: "NotFound", message: "User not found" }); return; }

    const { name, email, phone, profileImageUrl, role, superHubId, superHubIds, subHubId, subHubIds, status, password } = req.body;

    const isUnchangedLegacyDeliveryRole =
      user.role === LEGACY_DELIVERY_PERSON_ROLE && role === LEGACY_DELIVERY_PERSON_ROLE;
    if (role !== undefined && !ASSIGNABLE_USER_ROLES.has(String(role)) && !isUnchangedLegacyDeliveryRole) {
      res.status(400).json({ error: "ValidationError", message: "Choose Master Admin, Super Hub Admin, or Sub Hub Admin. Delivery Person is no longer assignable." });
      return;
    }

    if (email !== undefined && !EMAIL_REGEX.test(email)) {
      res.status(400).json({ error: "ValidationError", message: "Invalid email format" });
      return;
    }
    if (phone !== undefined && phone.trim() !== "" && !PHONE_REGEX.test(phone.trim())) {
      res.status(400).json({ error: "ValidationError", message: "Phone number must be exactly 10 digits" });
      return;
    }

    if (email !== undefined && email.toLowerCase().trim() !== String(user.email)) {
      const emailExists = await HubUser.findOne({ email: email.toLowerCase().trim(), _id: { $ne: user._id } });
      if (emailExists) {
        res.status(400).json({ error: "DuplicateEmail", message: "A user with this email already exists" });
        return;
      }
    }
    if (phone !== undefined && phone.trim() !== "" && phone.trim() !== user.phone) {
      const phoneExists = await HubUser.findOne({ phone: phone.trim(), _id: { $ne: user._id } });
      if (phoneExists) {
        res.status(400).json({ error: "DuplicatePhone", message: "A user with this phone number already exists" });
        return;
      }
    }

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (phone !== undefined) user.phone = phone.trim();
    if (profileImageUrl !== undefined) (user as any).profileImageUrl = profileImageUrl;
    if (role !== undefined) user.role = role;
    if (status !== undefined) user.status = status;

    if (superHubIds !== undefined || superHubId !== undefined) {
      const resolvedIds: string[] = Array.isArray(superHubIds) && superHubIds.length > 0 ? superHubIds : superHubId ? [superHubId] : [];
      (user as any).superHubIds = resolvedIds;
      user.superHubId = resolvedIds[0] || null;
    }
    if (subHubIds !== undefined || subHubId !== undefined) {
      const resolvedSubIds: string[] = Array.isArray(subHubIds) && subHubIds.length > 0 ? subHubIds : subHubId ? [subHubId] : [];
      (user as any).subHubIds = resolvedSubIds;
      user.subHubId = resolvedSubIds[0] || null;
    }

    if (password && password.trim() !== "") {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    const enriched = await enrichUser(user);
    res.json({ user: enriched });
  } catch (err) {
    req.log.error({ err }, "Failed to update user");
    res.status(500).json({ error: "InternalError", message: "Failed to update user" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const user = await HubUser.findById(req.params.id);
    if (!user) { res.status(404).json({ error: "NotFound", message: "User not found" }); return; }
    await HubUser.findByIdAndDelete(req.params.id);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete user");
    res.status(500).json({ error: "InternalError", message: "Failed to delete user" });
  }
});

router.patch("/:id/toggle-status", async (req, res) => {
  try {
    const user = await HubUser.findById(req.params.id);
    if (!user) { res.status(404).json({ error: "NotFound", message: "User not found" }); return; }
    user.status = user.status === "Active" ? "Inactive" : "Active";
    await user.save();
    const enriched = await enrichUser(user);
    res.json({ user: enriched });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle user status");
    res.status(500).json({ error: "InternalError", message: "Failed to toggle status" });
  }
});

export default router;
