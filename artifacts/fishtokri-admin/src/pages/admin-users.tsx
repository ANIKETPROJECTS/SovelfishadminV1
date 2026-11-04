import { useState, useEffect } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Plus, Search, Edit2, Trash2, Mail, Phone, Eye, EyeOff, ArrowUpDown, SlidersHorizontal, X, LayoutGrid, LayoutList } from "lucide-react";
import { ImageUpload } from "@/components/image-upload";
import PasswordResetInbox from "@/components/password-reset-inbox";
import { PaginationBar } from "@/components/pagination-bar";
import { usePaginated } from "@/hooks/use-paginated";
import {
  useGetUsers,
  getGetUsersQueryKey,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  useToggleUserStatus,
  useGetSuperHubs,
  getGetSuperHubsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function getToken() {
  return localStorage.getItem("fishtokri_token") || "";
}

function useAllSubHubs() {
  return useQuery({
    queryKey: ["all-sub-hubs"],
    queryFn: async () => {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const res = await fetch(`${base}/api/sub-hubs`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Failed to fetch sub hubs");
      return res.json() as Promise<{ subHubs: any[]; total: number }>;
    },
  });
}

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-green-100 text-green-700",
  "bg-amber-100 text-amber-700",
  "bg-pink-100 text-pink-700",
  "bg-teal-100 text-teal-700",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").substring(0, 2).toUpperCase();
}

function RoleBadge({ role }: { role: string }) {
  if (role === "super_admin")
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold bg-[#162B4D] text-white">Master Admin</span>;
  if (role === "super_hub")
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold bg-[#1A56DB] text-white">Super Hub</span>;
  if (role === "delivery_person")
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold bg-orange-500 text-white">Delivery Person</span>;
  return <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold bg-teal-600 text-white">Sub Hub</span>;
}

export default function AdminUsers() {
  const { data: usersData, isLoading } = useGetUsers(undefined, {
    query: { queryKey: getGetUsersQueryKey() },
  });

  const users = usersData?.users || [];
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "super_admin" | "super_hub" | "sub_hub">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "Active" | "Inactive">("all");
  const [sort, setSort] = useState<"name_asc" | "name_desc" | "role" | "status">("name_asc");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const toggleStatus = useToggleUserStatus();

  const filteredUsers = users
    .filter((user) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !q ||
        user.name.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q) ||
        user.role.toLowerCase().includes(q);
      const matchesRole = roleFilter === "all" || user.role === roleFilter;
      const matchesStatus = statusFilter === "all" || user.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    })
    .sort((a, b) => {
      if (sort === "name_asc") return a.name.localeCompare(b.name);
      if (sort === "name_desc") return b.name.localeCompare(a.name);
      if (sort === "role") return a.role.localeCompare(b.role);
      if (sort === "status") return a.status.localeCompare(b.status);
      return 0;
    });

  const hasFilters = search || roleFilter !== "all" || statusFilter !== "all";

  const pagedUsers = usePaginated(filteredUsers, 20, `${search}|${roleFilter}|${statusFilter}|${sort}`);

  const handleToggleStatus = (id: string) => {
    toggleStatus.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Status updated" });
        queryClient.invalidateQueries({ queryKey: getGetUsersQueryKey() });
      },
    });
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-[#162B4D]">Admin & Staff Users</h2>
          <p className="text-gray-500 text-sm mt-1">Manage system access and roles across all hubs.</p>
        </div>
        <Button
          onClick={() => { setEditingUser(null); setIsModalOpen(true); }}
          className="bg-[#1A56DB] hover:bg-[#1447B4] text-white h-9 px-4 text-sm font-semibold"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add User
        </Button>
      </div>

      <PasswordResetInbox />

      {/* Search, Sort, Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search by name, email or role..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-white border-gray-200 h-9 text-sm"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <Select value={roleFilter} onValueChange={(v: any) => setRoleFilter(v)}>
            <SelectTrigger className="h-9 w-44 text-sm border-gray-200 bg-white">
              <SelectValue placeholder="Filter by role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Roles</SelectItem>
              <SelectItem value="super_admin">Master Admin</SelectItem>
              <SelectItem value="super_hub">Super Hub</SelectItem>
              <SelectItem value="sub_hub">Sub Hub</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
          <SelectTrigger className="h-9 w-36 text-sm border-gray-200 bg-white">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="Active">Active</SelectItem>
            <SelectItem value="Inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <ArrowUpDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <Select value={sort} onValueChange={(v: any) => setSort(v)}>
            <SelectTrigger className="h-9 w-40 text-sm border-gray-200 bg-white">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name_asc">Name (A → Z)</SelectItem>
              <SelectItem value="name_desc">Name (Z → A)</SelectItem>
              <SelectItem value="role">Role</SelectItem>
              <SelectItem value="status">Status</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {hasFilters && (
          <button onClick={() => { setSearch(""); setRoleFilter("all"); setStatusFilter("all"); }} className="text-xs text-[#1A56DB] hover:underline font-medium">
            Clear filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium">
            {filteredUsers.length} of {users.length} user{users.length !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white">
            <button
              onClick={() => setViewMode("list")}
              className={`w-8 h-8 flex items-center justify-center transition-colors ${viewMode === "list" ? "bg-[#162B4D] text-white" : "text-gray-400 hover:bg-gray-50"}`}
              title="List view"
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`w-8 h-8 flex items-center justify-center transition-colors ${viewMode === "grid" ? "bg-[#162B4D] text-white" : "text-gray-400 hover:bg-gray-50"}`}
              title="Grid view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {viewMode === "grid" ? (
        isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="bg-white rounded-xl border border-dashed border-gray-200 py-20 text-center">
            <p className="text-gray-500 font-medium">No users found.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {pagedUsers.pageItems.map((user) => (
                <UserCard
                  key={user.id}
                  user={user}
                  onEdit={() => { setEditingUser(user); setIsModalOpen(true); }}
                  onDelete={() => setDeleteUserId(user.id)}
                  onToggle={() => handleToggleStatus(user.id)}
                />
              ))}
            </div>
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mt-4">
              <PaginationBar
                page={pagedUsers.page}
                pages={pagedUsers.pages}
                total={pagedUsers.total}
                onChange={pagedUsers.setPage}
                label="users"
              />
            </div>
          </>
        )
      ) : (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">

        {isLoading ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/50 hover:bg-gray-50/50">
                <TableHead className="text-xs font-semibold text-gray-500 uppercase tracking-wider py-3">User Details</TableHead>
                <TableHead className="text-xs font-semibold text-gray-500 uppercase tracking-wider py-3">Role</TableHead>
                <TableHead className="text-xs font-semibold text-gray-500 uppercase tracking-wider py-3">Assigned Hub</TableHead>
                <TableHead className="text-xs font-semibold text-gray-500 uppercase tracking-wider py-3">Status</TableHead>
                <TableHead className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider py-3">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-gray-400 text-sm">
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                pagedUsers.pageItems.map((user) => (
                  <TableRow key={user.id} className="hover:bg-gray-50/40 border-gray-100">
                    <TableCell className="py-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9 flex-shrink-0">
                          {(user as any).profileImageUrl && (
                            <AvatarImage src={(user as any).profileImageUrl} alt={user.name} className="object-cover" />
                          )}
                          <AvatarFallback className={`text-sm font-bold ${getAvatarColor(user.name)}`}>
                            {getInitials(user.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-semibold text-[#162B4D] text-sm">{user.name}</p>
                          <div className="flex items-center gap-1 text-gray-500 text-xs mt-0.5">
                            <Mail className="w-3 h-3" />
                            <span>{user.email}</span>
                          </div>
                          {user.phone && (
                            <div className="flex items-center gap-1 text-gray-400 text-xs mt-0.5">
                              <Phone className="w-3 h-3" />
                              <span>{user.phone}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell className="py-4">
                      {user.role === "super_admin" ? (
                        <span className="text-gray-400 text-sm italic">All Hubs</span>
                      ) : user.role === "super_hub" ? (
                        <div className="flex flex-wrap gap-1">
                          {Array.isArray((user as any).superHubNames) && (user as any).superHubNames.length > 0 ? (
                            (user as any).superHubNames.map((n: string) => (
                              <span key={n} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                                {n}
                              </span>
                            ))
                          ) : user.superHubName ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                              {user.superHubName}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic text-sm">—</span>
                          )}
                        </div>
                      ) : user.role === "delivery_person" ? (
                        <div className="flex flex-wrap gap-1">
                          {Array.isArray((user as any).superHubNames) && (user as any).superHubNames.length > 0 && (
                            (user as any).superHubNames.map((n: string) => (
                              <span key={n} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                                {n}
                              </span>
                            ))
                          )}
                          {Array.isArray((user as any).subHubNames) && (user as any).subHubNames.length > 0 && (
                            (user as any).subHubNames.map((n: string) => (
                              <span key={n} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-50 text-teal-700">
                                {n}
                              </span>
                            ))
                          )}
                          {!((user as any).superHubNames?.length) && !((user as any).subHubNames?.length) && (
                            <span className="text-gray-400 italic text-sm">—</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {Array.isArray((user as any).subHubNames) && (user as any).subHubNames.length > 0 ? (
                            (user as any).subHubNames.map((n: string) => (
                              <span key={n} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-50 text-teal-700">
                                {n}
                              </span>
                            ))
                          ) : (user as any).subHubName ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-50 text-teal-700">
                              {(user as any).subHubName}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic text-sm">—</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold border ${
                          user.status === "Active"
                            ? "bg-green-50 text-green-700 border-green-200"
                            : "bg-gray-100 text-gray-500 border-gray-200"
                        }`}
                      >
                        {user.status}
                      </span>
                    </TableCell>
                    <TableCell className="py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => { setEditingUser(user); setIsModalOpen(true); }}
                          className="w-8 h-8 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:text-[#1A56DB] hover:border-blue-200 hover:bg-blue-50 transition-colors"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteUserId(user.id)}
                          className="w-8 h-8 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
        <PaginationBar
          page={pagedUsers.page}
          pages={pagedUsers.pages}
          total={pagedUsers.total}
          onChange={pagedUsers.setPage}
          label="users"
        />
      </div>
      )}

      <UserModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} user={editingUser} />
      <DeleteUserDialog userId={deleteUserId} onClose={() => setDeleteUserId(null)} />
    </div>
  );
}

function UserCard({ user, onEdit, onDelete, onToggle }: { user: any; onEdit: () => void; onDelete: () => void; onToggle: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="h-10 w-10 flex-shrink-0">
            {(user as any).profileImageUrl && (
              <AvatarImage src={(user as any).profileImageUrl} alt={user.name} className="object-cover" />
            )}
            <AvatarFallback className={`text-sm font-bold ${getAvatarColor(user.name)}`}>
              {getInitials(user.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-semibold text-[#162B4D] text-sm truncate">{user.name}</p>
            <RoleBadge role={user.role} />
          </div>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border flex-shrink-0 ${user.status === "Active" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200"}`}>
          {user.status}
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-gray-500 text-xs">
          <Mail className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{user.email}</span>
        </div>
        {user.phone && (
          <div className="flex items-center gap-1.5 text-gray-400 text-xs">
            <Phone className="w-3 h-3 flex-shrink-0" />
            <span>{user.phone}</span>
          </div>
        )}
      </div>
      <div className="pt-2 border-t border-gray-100 flex items-center justify-end gap-1.5">
        <button onClick={onEdit} className="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:text-[#1A56DB] hover:border-blue-200 hover:bg-blue-50 transition-colors">
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={onDelete} className="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{10}$/;

function UserModal({ isOpen, onClose, user }: { isOpen: boolean; onClose: () => void; user: any }) {
  const isEditing = !!user;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMutation = useCreateUser();
  const updateMutation = useUpdateUser();

  const { data: superHubsData } = useGetSuperHubs(undefined, {
    query: { queryKey: getGetSuperHubsQueryKey() },
  });

  const { data: allSubHubsData } = useAllSubHubs();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<"super_admin" | "super_hub" | "sub_hub" | "delivery_person">("super_hub");
  const [superHubIds, setSuperHubIds] = useState<string[]>([]);
  const [subHubIds, setSubHubIds] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setFieldErrors({});
      if (user) {
        setName(user.name);
        setEmail(user.email);
        setPhone(user.phone || "");
        setProfileImageUrl((user as any).profileImageUrl || "");
        setPassword("");
        setRole(user.role as any);
        const ids: string[] = Array.isArray(user.superHubIds) && user.superHubIds.length > 0
          ? user.superHubIds
          : user.superHubId ? [user.superHubId] : [];
        setSuperHubIds(ids);
        const subIds: string[] = Array.isArray(user.subHubIds) && user.subHubIds.length > 0
          ? user.subHubIds
          : user.subHubId ? [user.subHubId] : [];
        setSubHubIds(subIds);
        setIsActive(user.status === "Active");
      } else {
        setName(""); setEmail(""); setPhone(""); setProfileImageUrl(""); setPassword(""); setRole("super_hub");
        setSuperHubIds([]); setSubHubIds([]); setIsActive(true);
      }
    }
  }, [isOpen, user]);

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!EMAIL_REGEX.test(email)) errors.email = "Enter a valid email address";
    if (phone.trim() && !PHONE_REGEX.test(phone.trim())) errors.phone = "Phone must be exactly 10 digits (numbers only)";
    if (!isEditing && !password.trim()) errors.password = "Password is required";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const payload: any = {
      name, email, phone, profileImageUrl, role,
      superHubIds: (role === "super_hub" || role === "delivery_person") ? superHubIds : undefined,
      subHubIds: (role === "sub_hub" || role === "delivery_person") ? subHubIds : undefined,
      status: isActive ? "Active" : ("Inactive" as const),
    };
    if (!isEditing) payload.password = password;
    else if (password.trim()) payload.password = password;
    if (isEditing) {
      updateMutation.mutate({ id: user.id, data: payload }, {
        onSuccess: () => {
          toast({ title: "User updated" });
          queryClient.invalidateQueries({ queryKey: getGetUsersQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["all-sub-hubs"] });
          onClose();
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.message || err?.message || "Failed to update user";
          if (msg.toLowerCase().includes("email")) setFieldErrors((p) => ({ ...p, email: msg }));
          else if (msg.toLowerCase().includes("phone")) setFieldErrors((p) => ({ ...p, phone: msg }));
          else toast({ title: "Error", description: msg, variant: "destructive" });
        },
      });
    } else {
      createMutation.mutate({ data: payload as any }, {
        onSuccess: () => {
          toast({ title: "User created" });
          queryClient.invalidateQueries({ queryKey: getGetUsersQueryKey() });
          onClose();
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.message || err?.message || "Failed to create user";
          if (msg.toLowerCase().includes("email")) setFieldErrors((p) => ({ ...p, email: msg }));
          else if (msg.toLowerCase().includes("phone")) setFieldErrors((p) => ({ ...p, phone: msg }));
          else toast({ title: "Error", description: msg, variant: "destructive" });
        },
      });
    }
  };

  const allSubHubs = allSubHubsData?.subHubs || [];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[#162B4D]">{isEditing ? "Edit User" : "Add New User"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <ImageUpload
            value={profileImageUrl}
            onChange={setProfileImageUrl}
            folder="fishtokri/users"
            label="Profile Image"
            previewClassName="w-12 h-12 rounded-full"
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-gray-600">Name *</Label>
              <Input required value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-gray-600">Phone</Label>
              <Input
                value={phone}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 10);
                  setPhone(v);
                  if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: "" }));
                }}
                className={`h-9 ${fieldErrors.phone ? "border-red-400" : ""}`}
                placeholder="10 digits only"
                maxLength={10}
              />
              {fieldErrors.phone && <p className="text-xs text-red-500">{fieldErrors.phone}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-gray-600">Email *</Label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: "" }));
              }}
              className={`h-9 ${fieldErrors.email ? "border-red-400" : ""}`}
            />
            {fieldErrors.email && <p className="text-xs text-red-500">{fieldErrors.email}</p>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-gray-600">
              {isEditing ? "New Password" : "Password *"}
              {isEditing && <span className="text-gray-400 font-normal ml-1">(leave blank to keep current)</span>}
            </Label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                required={!isEditing}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: "" }));
                }}
                className={`h-9 pr-9 ${fieldErrors.password ? "border-red-400" : ""}`}
                placeholder={isEditing ? "Enter new password to change" : "Min. 6 characters"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {fieldErrors.password && <p className="text-xs text-red-500">{fieldErrors.password}</p>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-gray-600">Role</Label>
            <Select value={role} onValueChange={(v: any) => { setRole(v); setSuperHubIds([]); setSubHubIds([]); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">Master Admin</SelectItem>
                <SelectItem value="super_hub">Super Hub Admin</SelectItem>
                <SelectItem value="sub_hub">Sub Hub Admin</SelectItem>
                {isEditing && user?.role === "delivery_person" && (
                  <SelectItem value="delivery_person" disabled>Delivery Person (existing account)</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {role === "super_hub" && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-gray-600">Assigned Super Hubs</Label>
              <div className="border border-gray-200 rounded-lg p-2 max-h-40 overflow-y-auto bg-white space-y-1">
                {!superHubsData?.superHubs?.length ? (
                  <p className="text-xs text-gray-400 px-2 py-1">No super hubs available</p>
                ) : (
                  superHubsData.superHubs.map((hub) => {
                    const checked = superHubIds.includes(hub.id);
                    return (
                      <label key={hub.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSuperHubIds(checked
                              ? superHubIds.filter((id) => id !== hub.id)
                              : [...superHubIds, hub.id]
                            );
                          }}
                          className="w-3.5 h-3.5 accent-[#1A56DB]"
                        />
                        <span className="text-sm text-gray-700">{hub.name}</span>
                        {hub.status !== "Active" && (
                          <span className="text-[10px] text-red-500 ml-auto">Inactive</span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
              {superHubIds.length > 0 && (
                <p className="text-[11px] text-[#1A56DB]">{superHubIds.length} hub{superHubIds.length > 1 ? "s" : ""} selected</p>
              )}
            </div>
          )}

          {role === "delivery_person" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-gray-600">Assigned Super Hubs</Label>
                <div className="border border-gray-200 rounded-lg p-2 max-h-36 overflow-y-auto bg-white space-y-1">
                  {!superHubsData?.superHubs?.length ? (
                    <p className="text-xs text-gray-400 px-2 py-1">No super hubs available</p>
                  ) : (
                    superHubsData.superHubs.map((hub) => {
                      const checked = superHubIds.includes(hub.id);
                      return (
                        <label key={hub.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSuperHubIds(checked ? superHubIds.filter((id) => id !== hub.id) : [...superHubIds, hub.id])}
                            className="w-3.5 h-3.5 accent-[#1A56DB]"
                          />
                          <span className="text-sm text-gray-700">{hub.name}</span>
                          {hub.status !== "Active" && <span className="text-[10px] text-red-500 ml-auto">Inactive</span>}
                        </label>
                      );
                    })
                  )}
                </div>
                {superHubIds.length > 0 && <p className="text-[11px] text-[#1A56DB]">{superHubIds.length} super hub{superHubIds.length > 1 ? "s" : ""} selected</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-gray-600">Assigned Sub Hubs</Label>
                <div className="border border-gray-200 rounded-lg p-2 max-h-36 overflow-y-auto bg-white space-y-1">
                  {!allSubHubs.length ? (
                    <p className="text-xs text-gray-400 px-2 py-1">No sub hubs available</p>
                  ) : (
                    allSubHubs.map((hub: any) => {
                      const checked = subHubIds.includes(hub.id);
                      return (
                        <label key={hub.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSubHubIds(checked ? subHubIds.filter((id) => id !== hub.id) : [...subHubIds, hub.id])}
                            className="w-3.5 h-3.5 accent-orange-500"
                          />
                          <span className="text-sm text-gray-700">{hub.name}</span>
                          {hub.superHubName && <span className="text-[10px] text-gray-400 ml-1">· {hub.superHubName}</span>}
                          {hub.status !== "Active" && <span className="text-[10px] text-red-500 ml-auto">Inactive</span>}
                        </label>
                      );
                    })
                  )}
                </div>
                {subHubIds.length > 0 && <p className="text-[11px] text-orange-500">{subHubIds.length} sub hub{subHubIds.length > 1 ? "s" : ""} selected</p>}
              </div>
            </div>
          )}

          {role === "sub_hub" && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-gray-600">Assigned Sub Hubs</Label>
              <div className="border border-gray-200 rounded-lg p-2 max-h-48 overflow-y-auto bg-white space-y-1">
                {!allSubHubs.length ? (
                  <p className="text-xs text-gray-400 px-2 py-1">No sub hubs available</p>
                ) : (
                  allSubHubs.map((hub: any) => {
                    const checked = subHubIds.includes(hub.id);
                    return (
                      <label key={hub.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSubHubIds(checked
                              ? subHubIds.filter((id) => id !== hub.id)
                              : [...subHubIds, hub.id]
                            );
                          }}
                          className="w-3.5 h-3.5 accent-teal-600"
                        />
                        <span className="text-sm text-gray-700">{hub.name}</span>
                        {hub.superHubName && (
                          <span className="text-[10px] text-gray-400 ml-1">· {hub.superHubName}</span>
                        )}
                        {hub.status !== "Active" && (
                          <span className="text-[10px] text-red-500 ml-auto">Inactive</span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
              {subHubIds.length > 0 && (
                <p className="text-[11px] text-teal-600">{subHubIds.length} sub hub{subHubIds.length > 1 ? "s" : ""} selected</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <Label className="text-sm text-gray-700">Active</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} className="data-[state=checked]:bg-[#1A56DB]" />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="h-9">Cancel</Button>
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending} className="bg-[#1A56DB] hover:bg-[#1447B4] h-9">
              {isEditing ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteMutation = useDeleteUser();

  const handleDelete = () => {
    if (!userId) return;
    deleteMutation.mutate({ id: userId }, {
      onSuccess: () => {
        toast({ title: "User deleted" });
        queryClient.invalidateQueries({ queryKey: getGetUsersQueryKey() });
        onClose();
      },
    });
  };

  return (
    <Dialog open={!!userId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>This user will lose all access immediately. This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="pt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleDelete} className="bg-red-600 hover:bg-red-700 text-white" disabled={deleteMutation.isPending}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
