import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  BotIcon,
  Building2Icon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  ClockIcon,
  FilterIcon,
  Globe2Icon,
  LayoutDashboardIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldPlusIcon,
  Trash2Icon,
  UsersRoundIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { readListPreferences, writeListPreferences } from "@/lib/list-preferences";
import {
  buildMembershipRemovalConfirmation,
  buildMembershipRoleChangeConfirmation,
} from "./membership-removal-confirmation";
import { buildOverviewTenantNavigation } from "./overview-tenant-navigation";
import { createLatestRequestGate } from "./latest-request-gate";
import { summarizeTenantRuntime } from "./tenant-runtime-summary";
import type { AuditLogItem, Pagination, SystemQueueSnapshot, SystemRole, SystemTenant, SystemUser, SystemUserRelations, TenantRole, TenantStatus } from "@/types/app";
import { PaginationControls } from "@/components/app/utility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const statusLabels: Record<TenantStatus, string> = {
  active: "运行中",
  paused: "暂停",
  archived: "归档",
};

const statusDescriptions: Record<TenantStatus, string> = {
  active: "允许用户进入并正常处理投稿。",
  paused: "临时暂停运营，保留数据和配置。",
  archived: "归档历史租户，默认不再出现在用户入口。",
};

const roleLabels: Record<TenantRole, string> = {
  submitter: "用户",
  reviewer: "审核员",
  admin: "管理员",
};

const lifecycleActions: Array<{ status: TenantStatus; label: string; icon: typeof PlayCircleIcon }> = [
  { status: "active", label: "恢复运行", icon: PlayCircleIcon },
  { status: "paused", label: "暂停租户", icon: PauseCircleIcon },
  { status: "archived", label: "归档租户", icon: ArchiveIcon },
];

type OpsSection = "overview" | "applications" | "tenants" | "users" | "audit" | "platform";

/** 开墙申请（只有系统运维能看到与处理）。 */
type OpsTenantApplication = {
  id: string;
  wallName: string;
  school: string | null;
  contact: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  applicant: {
    id: string;
    displayName: string | null;
    email: string | null;
    qqUin: string;
    registeredAt: string;
  };
  reviewedByName: string | null;
  tenants: Array<{ id: string; name: string; slug: string; status: string }>;
};
type OpsPanelMode = "system" | "operations";
type SystemUserRoleFilter = TenantRole | SystemRole;
type OpsUserListPreferences = {
  keyword: string;
  tenantFilterId: string;
  roleFilters: SystemUserRoleFilter[];
};

const userRoleFilters: Array<{ value: SystemUserRoleFilter; label: string }> = [
  { value: "operations_admin", label: "运营管理员" },
  { value: "system_operator", label: "系统运维" },
  { value: "admin", label: "管理员" },
  { value: "reviewer", label: "审核员" },
  { value: "submitter", label: "用户" },
];

function defaultPagination(): Pagination {
  return {
    page: 1,
    limit: 10,
    total: 0,
    pageCount: 1,
  };
}

function opsUserPreferencesKey(mode: OpsPanelMode) {
  return `ops.${mode}.users`;
}

function isSystemUserRoleFilter(value: unknown): value is SystemUserRoleFilter {
  return value === "submitter"
    || value === "reviewer"
    || value === "admin"
    || value === "operations_admin"
    || value === "system_operator";
}

function isOpsUserListPreferences(value: unknown): value is OpsUserListPreferences {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpsUserListPreferences>;
  return typeof candidate.keyword === "string"
    && typeof candidate.tenantFilterId === "string"
    && Array.isArray(candidate.roleFilters)
    && candidate.roleFilters.every(isSystemUserRoleFilter);
}

function normalizeOpsUserPreferences(mode: OpsPanelMode, preferences: OpsUserListPreferences): OpsUserListPreferences {
  return {
    keyword: preferences.keyword,
    tenantFilterId: preferences.tenantFilterId,
    roleFilters: preferences.roleFilters.filter((role) => mode === "system" || (role !== "system_operator" && role !== "operations_admin")),
  };
}

function readOpsUserListPreferences(mode: OpsPanelMode): OpsUserListPreferences {
  const fallback: OpsUserListPreferences = { keyword: "", tenantFilterId: "", roleFilters: [] };
  return normalizeOpsUserPreferences(
    mode,
    readListPreferences(opsUserPreferencesKey(mode), fallback, isOpsUserListPreferences),
  );
}

function writeOpsUserListPreferences(mode: OpsPanelMode, preferences: OpsUserListPreferences) {
  writeListPreferences(opsUserPreferencesKey(mode), normalizeOpsUserPreferences(mode, preferences));
}

const tenantSlugMinLength = 4;
const tenantSlugMaxLength = 16;
const tenantSlugPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// Operators shouldn't have to invent a URL slug. We generate a valid 4-16 char
// candidate (matches the backend ^[a-z0-9][a-z0-9-]*[a-z0-9]$ rule).
function generateWallSlug(existingSlugs: ReadonlySet<string> = new Set()) {
  for (let index = 0; index < 20; index += 1) {
    const candidate = `wall-${Math.random().toString(36).slice(2, 8)}`;
    if (!existingSlugs.has(candidate)) {
      return candidate;
    }
  }
  return `wall-${Date.now().toString(36)}`;
}

function createTenantFormState(existingSlugs?: ReadonlySet<string>) {
  return {
    name: "",
    slug: generateWallSlug(existingSlugs),
    host: "",
    themeColor: "#111827",
    botQqUin: "",
  };
}

export function OpsPanel({
  currentUserId,
  mode = "system",
  onTenantCreated,
  onEnterTenant,
}: {
  currentUserId: string;
  mode?: OpsPanelMode;
  onTenantCreated?: (() => Promise<void>) | undefined;
  onEnterTenant?: ((tenantId: string) => Promise<void>) | undefined;
}) {
  const isSystemMode = mode === "system";
  const tenantRequestGate = useRef(createLatestRequestGate());
  const overviewRequestGate = useRef(createLatestRequestGate());
  const [tenants, setTenants] = useState<SystemTenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [systemUserTotal, setSystemUserTotal] = useState<number | null>(null);
  const [operationsAdmins, setOperationsAdmins] = useState<SystemUser[]>([]);
  const [usersPagination, setUsersPagination] = useState<Pagination>(() => defaultPagination());
  const [userPage, setUserPage] = useState(1);
  const [userKeyword, setUserKeyword] = useState(() => readOpsUserListPreferences(mode).keyword);
  const [userKeywordDraft, setUserKeywordDraft] = useState(() => readOpsUserListPreferences(mode).keyword);
  const [userTenantFilterId, setUserTenantFilterId] = useState(() => readOpsUserListPreferences(mode).tenantFilterId);
  const [selectedUserRoleFilters, setSelectedUserRoleFilters] = useState<SystemUserRoleFilter[]>(() => readOpsUserListPreferences(mode).roleFilters);
  const [queue, setQueue] = useState<SystemQueueSnapshot | null>(null);
  const [queueLoadState, setQueueLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditPagination, setAuditPagination] = useState<Pagination>(() => defaultPagination());
  const [auditPage, setAuditPage] = useState(1);
  const [activeSection, setActiveSection] = useState<OpsSection>("overview");
  const [applications, setApplications] = useState<OpsTenantApplication[]>([]);
  const [applicationFilter, setApplicationFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [applicationPendingCount, setApplicationPendingCount] = useState(0);
  const [applicationsPagination, setApplicationsPagination] = useState<Pagination>(() => defaultPagination());
  const [applicationsPage, setApplicationsPage] = useState(1);
  const [loadingApplications, setLoadingApplications] = useState(false);
  const [reviewingApplicationId, setReviewingApplicationId] = useState("");
  const [tenantDeleteOpen, setTenantDeleteOpen] = useState(false);
  const [tenantDeleteConfirmName, setTenantDeleteConfirmName] = useState("");
  const [tenantDeleteAck, setTenantDeleteAck] = useState(false);
  const [deletingTenant, setDeletingTenant] = useState(false);
  const [userActionBusyKey, setUserActionBusyKey] = useState("");
  const [deleteUserTarget, setDeleteUserTarget] = useState<SystemUser | null>(null);
  const [deleteUserRelations, setDeleteUserRelations] = useState<SystemUserRelations | null>(null);
  const [deleteUserLoading, setDeleteUserLoading] = useState(false);
  const [deleteUserPosts, setDeleteUserPosts] = useState<"delete" | "keep">("delete");
  const [deleteUserTenants, setDeleteUserTenants] = useState<"delete" | "keep">("keep");
  const [deleteUserConfirm, setDeleteUserConfirm] = useState("");
  const [deletingUser, setDeletingUser] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingOperationsAdmins, setLoadingOperationsAdmins] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [assigningMembership, setAssigningMembership] = useState(false);
  const [accessBusyKey, setAccessBusyKey] = useState("");
  const [grantTenantByUserId, setGrantTenantByUserId] = useState<Record<string, string>>({});
  const [membershipDialogUser, setMembershipDialogUser] = useState<SystemUser | null>(null);
  const [membershipForm, setMembershipForm] = useState<{ tenantId: string; role: TenantRole | SystemRole }>({ tenantId: "", role: "submitter" });
  const [busyStatus, setBusyStatus] = useState<TenantStatus | "">("");
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [enteringTenantId, setEnteringTenantId] = useState("");
  const [savingHost, setSavingHost] = useState(false);
  const [savingManagementHost, setSavingManagementHost] = useState(false);
  const [hostDraft, setHostDraft] = useState("");
  const [managementHostDraft, setManagementHostDraft] = useState("");
  const [tenantDomainSuffix, setTenantDomainSuffix] = useState<string | null>(null);
  const [showArchivedTenants, setShowArchivedTenants] = useState(false);
  const [tenantKeyword, setTenantKeyword] = useState("");
  const [tenantCreateOpen, setTenantCreateOpen] = useState(false);
  const [tenantForm, setTenantForm] = useState(() => createTenantFormState());

  function navigateToTenantSection(tenantId: string) {
    const navigation = buildOverviewTenantNavigation({
      activeSection,
      selectedTenantId,
      tenantKeyword,
    }, tenantId);
    setTenantKeyword(navigation.tenantKeyword);
    setSelectedTenantId(navigation.selectedTenantId);
    setActiveSection(navigation.activeSection);
  }

  const visibleTenants = useMemo(
    () => showArchivedTenants ? tenants : tenants.filter((tenant) => tenant.status !== "archived"),
    [showArchivedTenants, tenants],
  );

  const filteredVisibleTenants = useMemo(() => {
    const keyword = tenantKeyword.trim().toLowerCase();
    if (!keyword) return visibleTenants;
    return visibleTenants.filter((tenant) => [tenant.name, tenant.slug, tenant.host ?? ""]
      .some((value) => value.toLowerCase().includes(keyword)));
  }, [tenantKeyword, visibleTenants]);

  const selectedTenant = useMemo(
    () => filteredVisibleTenants.find((tenant) => tenant.id === selectedTenantId) ?? filteredVisibleTenants[0],
    [filteredVisibleTenants, selectedTenantId],
  );

  const availableRoleFilters = useMemo(
    () => (isSystemMode ? userRoleFilters : userRoleFilters.filter((filter) => filter.value !== "system_operator" && filter.value !== "operations_admin")),
    [isSystemMode],
  );

  const summary = useMemo(
    () => ({
      active: tenants.filter((tenant) => tenant.status === "active").length,
      paused: tenants.filter((tenant) => tenant.status === "paused").length,
      archived: tenants.filter((tenant) => tenant.status === "archived").length,
      bots: tenants.reduce((sum, tenant) => sum + tenant.botAccountCount, 0),
    }),
    [tenants],
  );

  const existingTenantSlugs = useMemo(() => new Set(tenants.map((tenant) => tenant.slug)), [tenants]);
  const existingTenantHosts = useMemo(() => new Set(tenants.map((tenant) => tenant.host).filter((host): host is string => Boolean(host))), [tenants]);

  const tenantFormSlug = tenantForm.slug.trim();
  const tenantFormHost = tenantForm.host.trim();
  const expectedTenantHost = tenantFormHost || (tenantDomainSuffix && tenantFormSlug ? `${tenantFormSlug}.${tenantDomainSuffix}` : "");
  const slugLengthInvalid = tenantFormSlug.length > 0 && (tenantFormSlug.length < tenantSlugMinLength || tenantFormSlug.length > tenantSlugMaxLength);
  const slugFormatInvalid = tenantFormSlug.length > 0 && !tenantSlugPattern.test(tenantFormSlug);
  const slugAlreadyUsed = tenantFormSlug.length > 0 && existingTenantSlugs.has(tenantFormSlug);
  const expectedHostAlreadyUsed = expectedTenantHost.length > 0 && existingTenantHosts.has(expectedTenantHost);
  const tenantFormInvalid = slugLengthInvalid || slugFormatInvalid || slugAlreadyUsed || expectedHostAlreadyUsed;
  const tenantSlugHint = tenantFormHost
    ? "访问标识用于 URL 和内部标识，创建后不可修改。"
    : tenantDomainSuffix
      ? "访问标识会作为专属子域名前缀，创建后不可修改。"
      : "访问标识用于 URL 和内部标识，创建后不可修改。";
  const expectedTenantHostLabel = tenantFormHost ? "专属访问域名" : "预计访问域名";

  async function refreshOverview(nextSelectedId?: string) {
    const requestGeneration = tenantRequestGate.current.begin();
    const overviewGeneration = overviewRequestGate.current.begin();
    setLoadingOverview(true);
    setQueueLoadState("loading");
    try {
      const [data, queueResult, userResult] = await Promise.all([
        api<{ tenants: SystemTenant[]; tenantDomainSuffix?: string | null }>("/api/system/tenants"),
        api<SystemQueueSnapshot>("/api/system/queue")
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        api<{ total: number }>("/api/system/users?page=1&limit=1")
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
      ]);
      if (tenantRequestGate.current.isCurrent(requestGeneration)) {
        setTenants(data.tenants);
        setTenantDomainSuffix(data.tenantDomainSuffix ?? null);
        const candidateTenants = showArchivedTenants ? data.tenants : data.tenants.filter((tenant) => tenant.status !== "archived");
        const nextTenant = candidateTenants.find((tenant) => tenant.id === nextSelectedId) ?? candidateTenants.find((tenant) => tenant.id === selectedTenantId) ?? candidateTenants[0];
        setSelectedTenantId(nextTenant?.id ?? "");
      }
      if (overviewRequestGate.current.isCurrent(overviewGeneration)) {
        if (queueResult.ok) {
          setQueue(queueResult.value);
          setQueueLoadState("ready");
        } else {
          setQueue(null);
          setQueueLoadState("error");
          toast.error(queueResult.error instanceof Error ? `任务队列状态读取失败：${queueResult.error.message}` : "任务队列状态读取失败");
        }
        if (userResult.ok) {
          setSystemUserTotal(userResult.value.total);
        } else {
          setSystemUserTotal(null);
          toast.error(userResult.error instanceof Error ? `用户总数读取失败：${userResult.error.message}` : "用户总数读取失败");
        }
      }
      return data.tenants;
    } catch (caught) {
      if (!overviewRequestGate.current.isCurrent(overviewGeneration)) return [];
      setQueue(null);
      setQueueLoadState("error");
      throw caught;
    } finally {
      if (overviewRequestGate.current.isCurrent(overviewGeneration)) {
        setLoadingOverview(false);
      }
    }
  }

  async function refreshTenantRuntime() {
    const requestGeneration = tenantRequestGate.current.begin();
    const data = await api<{ tenants: SystemTenant[]; tenantDomainSuffix?: string | null }>("/api/system/tenants");
    if (!tenantRequestGate.current.isCurrent(requestGeneration)) return;
    setTenants(data.tenants);
    setTenantDomainSuffix(data.tenantDomainSuffix ?? null);
  }

  async function refreshSettings() {
    if (!isSystemMode) {
      setManagementHostDraft("");
      return;
    }

    setLoadingSettings(true);
    try {
      const data = await api<{ managementHost: string | null }>("/api/system/settings");
      setManagementHostDraft(data.managementHost ?? "");
    } finally {
      setLoadingSettings(false);
    }
  }

  async function refreshUsers(page = userPage) {
    setLoadingUsers(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(usersPagination.limit),
      });
      if (userTenantFilterId) {
        params.set("tenantId", userTenantFilterId);
      }
      if (selectedUserRoleFilters.length > 0) {
        params.set("roles", selectedUserRoleFilters.join(","));
      }
      if (userKeyword.trim()) {
        params.set("q", userKeyword.trim());
      }
      const data = await api<{ total: number; users: SystemUser[]; pagination: Pagination }>(`/api/system/users?${params}`);
      setUsers(data.users);
      setUsersPagination(data.pagination);
      setUserPage(data.pagination.page);
    } finally {
      setLoadingUsers(false);
    }
  }

  async function refreshOperationsAdmins() {
    if (!isSystemMode) {
      setOperationsAdmins([]);
      return;
    }

    setLoadingOperationsAdmins(true);
    try {
      const data = await api<{ users: SystemUser[] }>("/api/system/users?roles=operations_admin&page=1&limit=50");
      setOperationsAdmins(data.users);
    } finally {
      setLoadingOperationsAdmins(false);
    }
  }

  async function refreshAudit(page = auditPage) {
    setLoadingAudit(true);
    try {
      const data = await api<{ logs: AuditLogItem[]; pagination: Pagination }>(`/api/system/audit-logs?page=${page}&limit=${auditPagination.limit}`);
      setAuditLogs(data.logs);
      setAuditPagination(data.pagination);
      setAuditPage(data.pagination.page);
    } finally {
      setLoadingAudit(false);
    }
  }

  async function refreshAll() {
    await Promise.all([refreshOverview(), refreshSettings(), refreshUsers(userPage), refreshOperationsAdmins(), refreshAudit(auditPage)]);
  }

  async function refreshApplications(page = applicationsPage, filter = applicationFilter) {
    if (!isSystemMode) {
      return;
    }
    setLoadingApplications(true);
    try {
      const data = await api<{
        items: OpsTenantApplication[];
        pendingCount: number;
        pagination: Pagination;
      }>(`/api/system/tenant-applications?status=${filter}&page=${page}&limit=20`);
      setApplications(data.items);
      setApplicationPendingCount(data.pendingCount);
      setApplicationsPagination(data.pagination);
      setApplicationsPage(data.pagination.page);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "读取开墙申请失败");
    } finally {
      setLoadingApplications(false);
    }
  }

  async function reviewApplication(application: OpsTenantApplication, action: "approve" | "reject") {
    let note = "";
    if (action === "reject") {
      const input = window.prompt(`拒绝「${application.wallName}」的申请，可以填写理由（会展示给申请人）：`, "");
      if (input === null) {
        return;
      }
      note = input.trim();
    } else if (!window.confirm(`确认通过「${application.wallName}」的开墙申请？\n通过后该账号即可创建自己的校园墙。`)) {
      return;
    }
    setReviewingApplicationId(application.id);
    try {
      await api(`/api/system/tenant-applications/${application.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action, note: note || undefined }),
      });
      toast.success(action === "approve" ? "已通过，申请人现在可以创建校园墙了。" : "已拒绝该申请。");
      await refreshApplications(applicationsPage);
      await refreshAudit(1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setReviewingApplicationId("");
    }
  }

  async function deleteSelectedTenant() {
    if (!selectedTenant || deletingTenant) {
      return;
    }
    if (tenantDeleteConfirmName.trim() !== selectedTenant.name) {
      toast.error("请输入与校园墙完全一致的名称");
      return;
    }
    if (!tenantDeleteAck) {
      toast.error("请先导出备份并勾选确认");
      return;
    }
    setDeletingTenant(true);
    try {
      await api(`/api/system/tenants/${selectedTenant.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: tenantDeleteConfirmName.trim(), backupAcknowledged: true }),
      });
      toast.success(`已彻底删除校园墙「${selectedTenant.name}」。`);
      setTenantDeleteOpen(false);
      setTenantDeleteConfirmName("");
      setTenantDeleteAck(false);
      tenantRequestGate.current.invalidate();
      await refreshOverview();
      await refreshAudit(1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setDeletingTenant(false);
    }
  }

  /** 停用 / 恢复账号（仅系统运维；数据保留，可随时恢复）。 */
  async function toggleUserDisabled(user: SystemUser) {
    if (userActionBusyKey) {
      return;
    }
    const nextDisabled = !user.disabledAt;
    let reason = "";
    if (nextDisabled) {
      const input = window.prompt("停用该账号并填写原因（会展示给对方）：", "违反平台规则");
      if (input === null) {
        return;
      }
      reason = input.trim();
    } else if (!window.confirm(`确认恢复账号「${user.displayName ?? user.email ?? user.qqUin}」？`)) {
      return;
    }
    setUserActionBusyKey(`disable:${user.id}`);
    try {
      await api(`/api/system/users/${user.id}/disabled`, {
        method: "POST",
        body: JSON.stringify({ disabled: nextDisabled, ...(reason ? { reason } : {}) }),
      });
      toast.success(nextDisabled ? "已停用该账号，对方将无法登录。" : "已恢复该账号。");
      await refreshUsers(userPage);
      await refreshAudit(1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setUserActionBusyKey("");
    }
  }

  /** 打开删除账号对话框：先拉取关联预览，让运维决定稿件/校园墙怎么处理。 */
  async function openDeleteUserDialog(user: SystemUser) {
    setDeleteUserTarget(user);
    setDeleteUserRelations(null);
    setDeleteUserConfirm("");
    setDeleteUserPosts("delete");
    setDeleteUserTenants("keep");
    setDeleteUserLoading(true);
    try {
      const data = await api<SystemUserRelations>(`/api/system/users/${user.id}/relations`);
      setDeleteUserRelations(data);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "读取账号关联失败");
    } finally {
      setDeleteUserLoading(false);
    }
  }

  async function confirmDeleteUser() {
    if (!deleteUserTarget || deletingUser) {
      return;
    }
    setDeletingUser(true);
    try {
      const result = await api<{
        deletedTenants: string[];
        transferredTenants: string[];
        deletedPosts: number;
        reassignedPosts: number;
      }>(`/api/system/users/${deleteUserTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirm: deleteUserConfirm.trim(),
          posts: deleteUserPosts,
          tenants: deleteUserTenants,
        }),
      });
      const tenantNote = result.deletedTenants.length > 0
        ? `，同时删除了校园墙：${result.deletedTenants.join("、")}`
        : result.transferredTenants.length > 0
          ? `，校园墙已移交给你：${result.transferredTenants.join("、")}`
          : "";
      const postNote = deleteUserPosts === "delete" ? `，删除稿件 ${result.deletedPosts} 篇` : `，保留稿件 ${result.reassignedPosts} 篇（转交「已注销账号」）`;
      toast.success(`账号已删除${postNote}${tenantNote}。`);
      setDeleteUserTarget(null);
      setDeleteUserRelations(null);
      await refreshUsers(userPage);
      await refreshOverview();
      await refreshAudit(1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除账号失败");
    } finally {
      setDeletingUser(false);
    }
  }

  async function refreshCurrentSection() {
    if (activeSection === "overview") {
      await refreshOverview();
      return;
    }
    if (activeSection === "applications") {
      await refreshApplications(applicationsPage);
      return;
    }
    if (activeSection === "tenants") {
      await refreshOverview(selectedTenantId);
      return;
    }
    if (activeSection === "users") {
      await refreshUsers(userPage);
      return;
    }
    if (activeSection === "audit") {
      await refreshAudit(auditPage);
      return;
    }
    await Promise.all([refreshSettings(), refreshOperationsAdmins()]);
  }

  useEffect(() => {
    void refreshAll().catch((caught) => {
      toast.error(caught instanceof Error ? caught.message : "无法读取运维面板数据");
    });
  }, []);

  // 系统运维进入「开墙申请」页签时读取申请列表（待审核数量会显示在导航上）。
  useEffect(() => {
    if (!isSystemMode) {
      return;
    }
    if (activeSection !== "applications") {
      // 其它页签也顺手刷新一次待审核数量，便于在导航上看到红点计数。
      void refreshApplications(1, applicationFilter);
      return;
    }
    void refreshApplications(applicationsPage, applicationFilter);
  }, [activeSection, applicationFilter, isSystemMode]);

  useEffect(() => {
    if (activeSection !== "overview" && activeSection !== "tenants") return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshTenantRuntime().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [activeSection]);

  useEffect(() => {
    if (!isSystemMode && activeSection === "platform") {
      setActiveSection("overview");
    }
  }, [activeSection, isSystemMode]);

  useEffect(() => {
    const preferences = readOpsUserListPreferences(mode);
    setUserKeyword(preferences.keyword);
    setUserKeywordDraft(preferences.keyword);
    setUserTenantFilterId(preferences.tenantFilterId);
    setSelectedUserRoleFilters(preferences.roleFilters);
    setUserPage(1);
  }, [mode]);

  useEffect(() => {
    void refreshUsers(userPage).catch((caught) => {
      toast.error(caught instanceof Error ? caught.message : "无法读取全局用户");
    });
  }, [userPage, userKeyword, userTenantFilterId, selectedUserRoleFilters]);

  useEffect(() => {
    if (!userTenantFilterId || visibleTenants.some((tenant) => tenant.id === userTenantFilterId)) {
      return;
    }
    setUserTenantFilterId("");
    setSelectedUserRoleFilters([]);
    writeOpsUserListPreferences(mode, { keyword: userKeyword, tenantFilterId: "", roleFilters: [] });
    setUserPage(1);
  }, [mode, userKeyword, userTenantFilterId, visibleTenants]);

  useEffect(() => {
    void refreshAudit(auditPage).catch((caught) => {
      toast.error(caught instanceof Error ? caught.message : "无法读取审计日志");
    });
  }, [auditPage]);

  useEffect(() => {
    setHostDraft(selectedTenant?.host ?? "");
  }, [selectedTenant?.id, selectedTenant?.host]);

  // Subdomain-aware host editing. When an auto-domain suffix is configured and
  // the current draft is a host under that suffix (or empty), operators edit
  // just the subdomain prefix and the platform keeps the Cloudflare CNAME in
  // sync. A "custom domain" escape hatch still allows a fully custom host.
  const normalizedDomainSuffix = tenantDomainSuffix?.trim().replace(/^\*\./, "").replace(/^\./, "").toLowerCase() ?? null;
  const hostDraftTrimmed = hostDraft.trim().toLowerCase();
  const hostDraftIsUnderSuffix = Boolean(
    normalizedDomainSuffix && hostDraftTrimmed.length > 0 && hostDraftTrimmed.endsWith(`.${normalizedDomainSuffix}`),
  );
  const subdomainPrefix = hostDraftIsUnderSuffix && normalizedDomainSuffix
    ? hostDraftTrimmed.slice(0, hostDraftTrimmed.length - normalizedDomainSuffix.length - 1)
    : "";
  // Use the prefix editor when a suffix is configured and the draft is empty or
  // already a subdomain of it; a fully custom host falls back to raw editing.
  const useSubdomainEditor = Boolean(normalizedDomainSuffix) && (hostDraftTrimmed.length === 0 || hostDraftIsUnderSuffix);
  const subdomainPrefixInvalid = subdomainPrefix.length > 0 && !tenantSlugPattern.test(subdomainPrefix);

  function setSubdomainPrefix(prefix: string) {
    const cleaned = prefix.trim().toLowerCase();
    if (!normalizedDomainSuffix || cleaned.length === 0) {
      setHostDraft("");
      return;
    }
    setHostDraft(`${cleaned}.${normalizedDomainSuffix}`);
  }

  async function updateStatus(status: TenantStatus) {
    if (!selectedTenant || selectedTenant.status === status || busyStatus) {
      return;
    }

    if (status === "paused" || status === "archived") {
      const impact = status === "archived"
        ? "归档后普通成员将无法继续操作，系统运维仍可恢复。"
        : "暂停后校园墙将暂时停止对外服务，可随时恢复。";
      if (!window.confirm(`确认将「${selectedTenant.name}」调整为${statusLabels[status]}？

${impact}`)) {
        return;
      }
    }

    setBusyStatus(status);
    try {
      await api(`/api/system/tenants/${selectedTenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refreshOverview(selectedTenant.id);
      await refreshAudit(1);
      toast.success(`已将 ${selectedTenant.name} 调整为${statusLabels[status]}。`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "状态调整失败");
    } finally {
      setBusyStatus("");
    }
  }

  async function createTenant() {
    if (!tenantFormSlug) {
      toast.error("请填写访问标识");
      return;
    }
    if (slugLengthInvalid) {
      toast.error("访问标识需要 4 到 16 个字符");
      return;
    }
    if (slugFormatInvalid) {
      toast.error("访问标识只能使用小写字母、数字和连字符，且不能以连字符开头或结尾");
      return;
    }
    if (slugAlreadyUsed) {
      toast.error("这个访问标识已经被其他校园墙使用");
      return;
    }
    if (expectedHostAlreadyUsed) {
      toast.error("这个访问域名已经绑定到其他校园墙");
      return;
    }

    const slug = tenantFormSlug;
    let created: SystemTenant | undefined;
    let createdTenants: SystemTenant[];
    setCreatingTenant(true);
    try {
      const data = await api<{ tenants: SystemTenant[] }>("/api/system/tenants", {
        method: "POST",
        body: JSON.stringify({
          name: tenantForm.name.trim(),
          slug,
          host: tenantForm.host.trim() || null,
          themeColor: tenantForm.themeColor,
        }),
      });
      createdTenants = data.tenants;
      tenantRequestGate.current.invalidate();
      setTenants(data.tenants);
      created = data.tenants.find((tenant) => tenant.slug === slug);
      setSelectedTenantId(created?.id ?? data.tenants[0]?.id ?? "");
      setTenantForm(createTenantFormState(new Set(data.tenants.map((tenant) => tenant.slug))));
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "创建校园墙失败");
      return;
    } finally {
      setCreatingTenant(false);
    }

    setTenantCreateOpen(false);
    navigateToTenantSection(created?.id ?? createdTenants[0]?.id ?? "");

    const refreshResults = await Promise.allSettled([
      refreshOverview(created?.id),
      refreshUsers(userPage),
      refreshOperationsAdmins(),
      refreshAudit(1),
    ]);
    const overviewResult = refreshResults[0];
    if (overviewResult.status === "fulfilled") {
      created ??= overviewResult.value.find((tenant) => tenant.slug === slug);
    }
    if (refreshResults.some((result) => result.status === "rejected")) {
      toast.warning("校园墙已创建，但部分运维数据刷新失败；可稍后手动刷新。");
    }
    if (!created) {
      created = createdTenants.find((tenant) => tenant.slug === slug);
    }
    if (created) {
      setSelectedTenantId(created.id);
    }

    if (!created) {
      await onTenantCreated?.();
      toast.success("新校园墙已创建。");
      return;
    }

    if (!onEnterTenant) {
      await onTenantCreated?.();
      toast.success("新校园墙已创建，进入后按引导完成接入。");
      return;
    }

    setEnteringTenantId(created.id);
    try {
      toast.success("新校园墙已创建，正在打开接入引导。");
      await onEnterTenant(created.id);
      await onTenantCreated?.();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "校园墙已创建，但打开接入引导失败");
    } finally {
      setEnteringTenantId("");
    }
  }

  async function saveHost() {
    if (!selectedTenant) {
      return;
    }

    setSavingHost(true);
    try {
      await api(`/api/system/tenants/${selectedTenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          host: hostDraft.trim() || null,
        }),
      });
      await refreshOverview(selectedTenant.id);
      await refreshAudit(1);
      toast.success(hostDraft.trim() ? "入口 host 已更新。" : "入口 host 已清空。");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "host 更新失败");
    } finally {
      setSavingHost(false);
    }
  }

  async function saveManagementHost() {
    setSavingManagementHost(true);
    try {
      const data = await api<{ managementHost: string | null }>("/api/system/settings", {
        method: "PATCH",
        body: JSON.stringify({ managementHost: managementHostDraft.trim() || null }),
      });
      setManagementHostDraft(data.managementHost ?? "");
      toast.success(data.managementHost ? "管理端 host 已更新。" : "管理端 host 已清空。");
      await refreshAudit(1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "管理端 host 更新失败");
    } finally {
      setSavingManagementHost(false);
    }
  }

  async function enterTenantAsAdmin(tenant: SystemTenant) {
    if (!onEnterTenant) {
      return;
    }

    setEnteringTenantId(tenant.id);
    try {
      await onEnterTenant(tenant.id);
      toast.success(`正在以管理员身份进入 ${tenant.name}。`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "进入校园墙失败");
    } finally {
      setEnteringTenantId("");
    }
  }

  function toggleUserRoleFilter(role: SystemUserRoleFilter) {
    setSelectedUserRoleFilters((current) => {
      const next = current.includes(role) ? current.filter((item) => item !== role) : [...current, role];
      writeOpsUserListPreferences(mode, { keyword: userKeyword, tenantFilterId: userTenantFilterId, roleFilters: next });
      return next;
    });
    setUserPage(1);
  }

  function changeUserTenantFilter(tenantId: string) {
    const nextTenantId = tenantId === "all" ? "" : tenantId;
    setUserTenantFilterId(nextTenantId);
    setSelectedUserRoleFilters([]);
    writeOpsUserListPreferences(mode, { keyword: userKeyword, tenantFilterId: nextTenantId, roleFilters: [] });
    setUserPage(1);
  }

  function openMembershipDialog(user: SystemUser) {
    const preferredTenant = selectedTenant ?? visibleTenants.find((tenant) => tenant.status === "active") ?? visibleTenants[0];
    setMembershipDialogUser(user);
    setMembershipForm({ tenantId: preferredTenant?.id ?? "", role: "submitter" });
  }

  async function assignMembership() {
    const assigningGlobalRole = membershipForm.role === "system_operator" || membershipForm.role === "operations_admin";
    if (!membershipDialogUser || (!assigningGlobalRole && !membershipForm.tenantId)) {
      return;
    }

    if (
      membershipForm.role === "submitter"
      || membershipForm.role === "reviewer"
      || membershipForm.role === "admin"
    ) {
      const existingMembership = membershipDialogUser.memberships.find(
        (membership) => membership.tenant.id === membershipForm.tenantId,
      );
      if (existingMembership) {
        const confirmation = buildMembershipRoleChangeConfirmation({
          actorUserId: currentUserId,
          targetUserId: membershipDialogUser.id,
          tenantName: existingMembership.tenant.name,
          currentRole: existingMembership.role,
          nextRole: membershipForm.role,
        });
        if (confirmation && !window.confirm(confirmation)) {
          return;
        }
      }
    }

    setAssigningMembership(true);
    try {
      const result = await api<{ ok: true; retainedHigherRole?: boolean }>(`/api/system/users/${membershipDialogUser.id}/memberships`, {
        method: "POST",
        body: JSON.stringify({
          role: membershipForm.role,
          ...(assigningGlobalRole ? {} : { tenantId: membershipForm.tenantId }),
        }),
      });
      if (result.retainedHigherRole) {
        toast.info("系统运维已经是最高平台身份，不会降级为运营管理员。");
      } else {
        toast.success(assigningGlobalRole ? "平台身份已添加。" : "用户身份已更新。");
      }
      setMembershipDialogUser(null);
      await Promise.all([refreshUsers(userPage), refreshOperationsAdmins(), refreshOverview(selectedTenantId), refreshAudit(1)]);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "添加身份失败");
    } finally {
      setAssigningMembership(false);
    }
  }

  async function grantOperationsAdminTenant(user: SystemUser) {
    const tenantId = grantTenantByUserId[user.id];
    if (!tenantId) {
      return;
    }

    const busyKey = `grant:${user.id}:${tenantId}`;
    setAccessBusyKey(busyKey);
    try {
      await api(`/api/system/users/${user.id}/memberships`, {
        method: "POST",
        body: JSON.stringify({
          tenantId,
          role: "admin",
        }),
      });
      setGrantTenantByUserId((current) => ({ ...current, [user.id]: "" }));
      toast.success("运营资源访问权已更新。");
      await Promise.all([refreshOperationsAdmins(), refreshUsers(userPage), refreshOverview(selectedTenantId), refreshAudit(1)]);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "授权失败");
    } finally {
      setAccessBusyKey("");
    }
  }

  async function revokeOperationsAdminTenant(user: SystemUser, membershipId: string, tenantName: string) {
    const confirmation = buildMembershipRemovalConfirmation({
      actorUserId: currentUserId,
      targetUserId: user.id,
      targetLabel: user.displayName ?? user.qqUin,
      tenantName,
      role: "admin",
      roleLabel: roleLabels.admin,
    });
    if (!window.confirm(confirmation)) {
      return;
    }

    const busyKey = `revoke:${membershipId}`;
    setAccessBusyKey(busyKey);
    try {
      await api(`/api/system/users/${user.id}/memberships/${membershipId}`, {
        method: "DELETE",
      });
      toast.success(`已移除 ${tenantName} 的访问权。`);
      await Promise.all([refreshOperationsAdmins(), refreshUsers(userPage), refreshOverview(selectedTenantId), refreshAudit(1)]);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "移除访问权失败");
    } finally {
      setAccessBusyKey("");
    }
  }

  async function revokeUserTenantMembership(user: SystemUser, membership: SystemUser["memberships"][number]) {
    const confirmation = buildMembershipRemovalConfirmation({
      actorUserId: currentUserId,
      targetUserId: user.id,
      targetLabel: user.displayName ?? user.qqUin,
      tenantName: membership.tenant.name,
      role: membership.role,
      roleLabel: roleLabels[membership.role],
    });
    if (!window.confirm(confirmation)) {
      return;
    }

    const busyKey = `revoke:${membership.id}`;
    setAccessBusyKey(busyKey);
    try {
      await api(`/api/system/users/${user.id}/memberships/${membership.id}`, {
        method: "DELETE",
      });
      toast.success(`已移除 ${membership.tenant.name} 的${roleLabels[membership.role]}身份。`);
      await Promise.all([refreshOperationsAdmins(), refreshUsers(userPage), refreshOverview(selectedTenantId), refreshAudit(1)]);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除租户身份失败");
    } finally {
      setAccessBusyKey("");
    }
  }

  const navigationItems: Array<{
    value: OpsSection;
    label: string;
    description: string;
    icon: typeof ActivityIcon;
  }> = [
    { value: "overview", label: "运行总览", description: "状态、队列与交付进度", icon: LayoutDashboardIcon },
    ...(isSystemMode
      ? [{
          value: "applications" as OpsSection,
          label: applicationPendingCount > 0 ? `开墙申请 (${applicationPendingCount})` : "开墙申请",
          description: "审核自助开墙申请",
          icon: ClipboardListIcon,
        }]
      : []),
    { value: "tenants", label: isSystemMode ? "校园墙" : "我的校园墙", description: "租户配置与生命周期", icon: Building2Icon },
    { value: "users", label: isSystemMode ? "全局用户" : "墙内用户", description: "账号、身份与权限", icon: UsersRoundIcon },
    { value: "audit", label: "审计日志", description: "平台操作记录", icon: ClipboardListIcon },
  ];
  if (isSystemMode) {
    navigationItems.push({ value: "platform", label: "平台设置", description: "域名与运营资源", icon: Settings2Icon });
  }
  const activeNavigationItem = navigationItems.find((item) => item.value === activeSection) ?? navigationItems[0]!;
  const sectionRefreshing = activeSection === "overview" || activeSection === "tenants"
    ? loadingOverview
    : activeSection === "users"
      ? loadingUsers
      : activeSection === "audit"
        ? loadingAudit
        : loadingSettings || loadingOperationsAdmins;

  return (
    <div className="pb-8">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <nav aria-label="运维页面导航" className="flex gap-2 overflow-x-auto rounded-lg border border-slate-200 bg-white p-2 lg:grid lg:gap-1 lg:p-2">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const active = activeSection === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className={`group flex min-w-[132px] items-center gap-3 rounded-md px-3 py-2.5 text-left transition lg:min-w-0 ${active ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}
                  onClick={() => setActiveSection(item.value)}
                >
                  <span className={`grid size-8 shrink-0 place-items-center rounded-md ${active ? "bg-white/10 text-white" : "bg-slate-100 text-slate-500 group-hover:text-slate-900"}`}>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold">{item.label}</span>
                    <span className={`mt-0.5 hidden truncate text-[11px] lg:block ${active ? "text-slate-300" : "text-slate-400"}`}>{item.description}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0">
          <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">{activeNavigationItem.label}</h2>
              <p className="mt-1 text-sm text-slate-500">{activeNavigationItem.description}</p>
            </div>
            <div className="flex items-center gap-2">
              {activeSection === "tenants" ? (
                <Button size="sm" onClick={() => setTenantCreateOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  新建校园墙
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={sectionRefreshing}
                onClick={() => void refreshCurrentSection().catch((caught) => toast.error(caught instanceof Error ? caught.message : "刷新失败"))}
              >
                <RefreshCwIcon className={sectionRefreshing ? "animate-spin" : ""} data-icon="inline-start" />
                刷新数据
              </Button>
            </div>
          </header>

          {activeSection === "overview" ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                <MetricCard title="运行中" value={summary.active} icon={ActivityIcon} accent="green" />
                <MetricCard title="暂停" value={summary.paused} icon={PauseCircleIcon} accent="amber" />
                <MetricCard title="归档" value={summary.archived} icon={ArchiveIcon} accent="slate" />
                <MetricCard title={isSystemMode ? "全局用户" : "可管理用户"} value={systemUserTotal ?? "—"} icon={UsersRoundIcon} accent="blue" />
                <MetricCard title="Bot 账号" value={summary.bots} icon={BotIcon} accent="violet" />
                <MetricCard title="队列中" value={queueLoadState === "ready" ? queue?.runtime.queued ?? 0 : "—"} icon={ActivityIcon} accent="amber" />
                <MetricCard title="发布失败" value={queueLoadState === "ready" ? queue?.publishAttempts.failed ?? 0 : "—"} icon={ClipboardListIcon} accent="rose" />
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
                <Card className="overflow-hidden rounded-lg">
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                      <div>
                        <p className="font-bold text-slate-950">校园墙概况</p>
                        <p className="mt-0.5 text-xs text-slate-500">直接定位需要处理的校园墙</p>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setActiveSection("tenants")}>查看全部</Button>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {visibleTenants.slice(0, 6).map((tenant) => (
                        <button
                          key={tenant.id}
                          type="button"
                          className="grid w-full gap-2 px-4 py-3 text-left transition hover:bg-slate-50 sm:grid-cols-[minmax(0,1.2fr)_110px_110px_24px] sm:items-center"
                          onClick={() => navigateToTenantSection(tenant.id)}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-slate-950">{tenant.name}</span>
                              <Badge variant={tenant.status === "active" ? "secondary" : "outline"}>{statusLabels[tenant.status]}</Badge>
                            </span>
                            <span className="mt-1 block truncate font-mono text-xs text-slate-500">{tenant.host ?? tenant.slug}</span>
                          </span>
                          <span className="text-xs text-slate-500"><strong className="mr-1 text-sm text-slate-900">{tenant.memberCount}</strong>用户</span>
                          <span className="text-xs text-slate-500"><strong className="mr-1 text-sm text-slate-900">{tenant.postCount}</strong>稿件</span>
                          <ChevronRightIcon className="hidden size-4 text-slate-400 sm:block" />
                        </button>
                      ))}
                      {visibleTenants.length === 0 ? <p className="px-4 py-10 text-center text-sm font-semibold text-slate-500">暂无校园墙。</p> : null}
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-lg">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-bold text-slate-950">任务队列</p>
                        <p className="mt-0.5 text-xs text-slate-500">运行时与发布任务健康状态</p>
                      </div>
                      <Badge variant={queueLoadState === "ready" && queue?.runtime.running ? "secondary" : "outline"}>
                        {queueLoadState === "loading" || queueLoadState === "idle" ? "读取中" : queueLoadState === "error" ? "读取失败" : queue?.runtime.running ? "运行中" : "已停止"}
                      </Badge>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <Metric label="处理中" value={queueLoadState === "ready" ? queue?.runtime.processing ?? 0 : "—"} />
                      <Metric label="运行失败" value={queueLoadState === "ready" ? queue?.runtime.failed ?? 0 : "—"} />
                      <Metric label="发布中" value={queueLoadState === "ready" ? queue?.publishAttempts.running ?? 0 : "—"} />
                      <Metric label="发布成功" value={queueLoadState === "ready" ? queue?.publishAttempts.succeeded ?? 0 : "—"} />
                    </div>
                    {queueLoadState === "error" ? (
                      <p className="mt-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">无法读取任务队列状态，请稍后刷新。</p>
                    ) : queueLoadState !== "ready" ? (
                      <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">正在读取任务队列状态…</p>
                    ) : queue?.runtime.lastError ? (
                      <div className="mt-3 rounded-md border border-red-100 bg-red-50 px-3 py-2">
                        <p className="text-xs font-bold text-red-700">最近错误</p>
                        <p className="mt-1 line-clamp-3 break-all text-xs leading-5 text-red-700">{queue.runtime.lastError}</p>
                      </div>
                    ) : (
                      <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-xs font-semibold text-green-800">当前没有运行时错误。</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <OnboardingGuide mode={mode} hasTenants={visibleTenants.length > 0} selectedTenant={selectedTenant} tenantDomainSuffix={tenantDomainSuffix} />
            </div>
          ) : null}

          {activeSection === "applications" ? (
            <div className="grid gap-4">
              <Card className="rounded-lg">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-950">开墙申请</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        运营者在登录页提交的开墙申请。通过后该账号即可创建自己的校园墙（每个账号 1 个）。
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={applicationFilter}
                        onValueChange={(value) => {
                          setApplicationFilter(value as "pending" | "approved" | "rejected" | "all");
                          setApplicationsPage(1);
                        }}
                      >
                        <SelectTrigger className="h-9 w-[128px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">待审核</SelectItem>
                          <SelectItem value="approved">已通过</SelectItem>
                          <SelectItem value="rejected">已拒绝</SelectItem>
                          <SelectItem value="all">全部</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" disabled={loadingApplications} onClick={() => void refreshApplications(applicationsPage)}>
                        刷新
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3">
                    {loadingApplications && applications.length === 0 ? (
                      <InlineLoading title="正在读取开墙申请" />
                    ) : applications.length === 0 ? (
                      <p className="rounded-md bg-slate-50 px-3 py-10 text-center text-sm font-semibold text-slate-500">
                        {applicationFilter === "pending" ? "当前没有待审核的开墙申请。" : "没有符合条件的申请。"}
                      </p>
                    ) : (
                      applications.map((application) => (
                        <div key={application.id} className="rounded-md border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-950">
                                {application.wallName}
                                <Badge variant={application.status === "pending" ? "secondary" : "outline"}>
                                  {application.status === "pending" ? "待审核" : application.status === "approved" ? "已通过" : "已拒绝"}
                                </Badge>
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                申请人：{application.applicant.displayName ?? "未命名"}
                                {application.applicant.email ? ` · ${application.applicant.email}` : ""}
                                {` · QQ ${application.applicant.qqUin}`}
                                {` · 提交于 ${formatOpsTime(application.createdAt)}`}
                              </p>
                            </div>
                            {application.status === "pending" ? (
                              <div className="flex shrink-0 items-center gap-2">
                                <Button
                                  size="sm"
                                  disabled={reviewingApplicationId === application.id}
                                  onClick={() => void reviewApplication(application, "approve")}
                                >
                                  通过
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={reviewingApplicationId === application.id}
                                  onClick={() => void reviewApplication(application, "reject")}
                                >
                                  拒绝
                                </Button>
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-3 grid gap-1 text-xs leading-5 text-slate-600">
                            {application.school ? <p>学校 / 单位：{application.school}</p> : null}
                            {application.contact ? <p>联系方式：{application.contact}</p> : null}
                            {application.reason ? <p className="whitespace-pre-wrap">用途说明：{application.reason}</p> : null}
                            {application.status !== "pending" ? (
                              <p className="text-slate-500">
                                处理结果：{application.status === "approved" ? "已通过" : "已拒绝"}
                                {application.reviewedByName ? ` · 处理人 ${application.reviewedByName}` : ""}
                                {application.reviewNote ? ` · 备注：${application.reviewNote}` : ""}
                              </p>
                            ) : null}
                            {application.tenants.length > 0 ? (
                              <p className="text-slate-500">该账号已在运营：{application.tenants.map((tenant) => tenant.name).join("、")}</p>
                            ) : null}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <PaginationControls
                    pagination={applicationsPagination}
                    busy={loadingApplications}
                    onPageChange={(page) => void refreshApplications(page)}
                  />
                </CardContent>
              </Card>
            </div>
          ) : null}

          {activeSection === "tenants" ? (
            <div className="grid min-w-0 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
              <Card className="min-w-0 rounded-lg xl:sticky xl:top-0 xl:self-start">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2">
                    <SearchIcon className="size-4 shrink-0 text-slate-400" />
                    <Input
                      aria-label="搜索校园墙"
                      className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                      placeholder="搜索名称、标识或域名"
                      value={tenantKeyword}
                      onChange={(event) => setTenantKeyword(event.target.value)}
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 px-1">
                    <p className="text-xs font-bold text-slate-500">{filteredVisibleTenants.length} 个校园墙</p>
                    {summary.archived > 0 ? (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowArchivedTenants((current) => !current)}>
                        {showArchivedTenants ? "隐藏归档" : `显示归档 ${summary.archived}`}
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-2 flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-1 xl:max-h-[calc(100dvh-245px)]">
                    {filteredVisibleTenants.map((tenant) => (
                      <button
                        key={tenant.id}
                        type="button"
                        aria-current={selectedTenant?.id === tenant.id ? "true" : undefined}
                        className={`rounded-md border px-3 py-2.5 text-left transition ${selectedTenant?.id === tenant.id ? "border-blue-200 bg-blue-50 ring-1 ring-blue-100" : "border-transparent bg-slate-50 hover:border-slate-200 hover:bg-white"}`}
                        onClick={() => setSelectedTenantId(tenant.id)}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{tenant.name}</span>
                          <Badge variant={tenant.status === "active" ? "secondary" : "outline"}>{statusLabels[tenant.status]}</Badge>
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="truncate font-mono text-[11px] text-slate-500">{tenant.slug}</span>
                          {tenant.status === "active" && !tenant.ready ? <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">未就绪</Badge> : null}
                          {tenant.status === "active" && tenant.archiveWarningAt ? <Badge variant="outline" className="border-red-200 bg-red-50 text-[10px] text-red-700">待存档</Badge> : null}
                        </span>
                        <span className="mt-2 flex gap-3 text-[11px] font-semibold text-slate-500">
                          <span>{tenant.memberCount} 用户</span>
                          <span>{tenant.botAccountCount} 墙号</span>
                          <span>{tenant.postCount} 稿件</span>
                        </span>
                        <TenantRuntimeStrip tenant={tenant} />
                      </button>
                    ))}
                    {filteredVisibleTenants.length === 0 ? (
                      <p className="rounded-md bg-slate-50 px-3 py-8 text-center text-sm font-semibold text-slate-500">{tenantKeyword ? "没有匹配的校园墙。" : summary.archived > 0 ? "当前没有未归档的校园墙。" : "暂无校园墙。"}</p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>

              {selectedTenant ? (
                <Card className="min-w-0 overflow-hidden rounded-lg">
                  <CardContent className="p-0">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-lg font-semibold text-slate-950">{selectedTenant.name}</h3>
                          <Badge variant={selectedTenant.status === "active" ? "secondary" : "outline"}>{statusLabels[selectedTenant.status]}</Badge>
                        </div>
                        <p className="mt-1 truncate font-mono text-xs text-slate-500">{selectedTenant.slug} · {selectedTenant.host ?? "未绑定专属 host"}</p>
                      </div>
                      {onEnterTenant ? (
                        <Button size="sm" className="font-medium" disabled={enteringTenantId === selectedTenant.id} onClick={() => void enterTenantAsAdmin(selectedTenant)}>
                          作为管理员进入
                        </Button>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-3 gap-px border-b border-slate-100 bg-slate-100">
                      <TenantMetric label="成员" value={selectedTenant.memberCount} />
                      <TenantMetric label="墙号" value={selectedTenant.botAccountCount} />
                      <TenantMetric label="稿件" value={selectedTenant.postCount} />
                    </div>

                    <div className="grid gap-4 p-4 2xl:grid-cols-2">
                      <section className="rounded-md border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-center gap-2 font-bold text-slate-950">
                          <ActivityIcon className="size-4" />
                          生命周期状态
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-500">{statusDescriptions[selectedTenant.status]}</p>
                        {selectedTenant.status === "active" && !selectedTenant.ready ? <p className="mt-2 text-xs font-semibold leading-5 text-amber-700">墙号机器人尚未接入。创建满 30 天仍未接入且成员不超过 2 人会被自动存档。</p> : null}
                        {selectedTenant.status === "active" && selectedTenant.archiveWarningAt ? <p className="mt-2 text-xs font-semibold leading-5 text-red-700">已发出自动存档预警，若仍未接入机器人将于预警 7 天后自动存档。</p> : null}
                        <div className="mt-4 flex flex-wrap gap-2">
                          {lifecycleActions.map((action) => {
                            const Icon = action.icon;
                            return (
                              <Button
                                key={action.status}
                                size="sm"
                                variant={selectedTenant.status === action.status ? "secondary" : "outline"}
                                disabled={selectedTenant.status === action.status || Boolean(busyStatus)}
                                onClick={() => void updateStatus(action.status)}
                              >
                                <Icon data-icon="inline-start" />
                                {action.label}
                              </Button>
                            );
                          })}
                        </div>
                      </section>

                      <section className="rounded-md border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-center gap-2 font-bold text-slate-950">
                          <Globe2Icon className="size-4" />
                          专属访问域名
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-500">从专属域名进入的用户会直接固定到当前校园墙。</p>
                        {useSubdomainEditor ? (
                          <>
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                              <div className="flex min-w-0 flex-1 items-stretch">
                                <Input className="min-w-0 rounded-r-none" placeholder="子域名前缀" value={subdomainPrefix} aria-invalid={subdomainPrefixInvalid} onChange={(event) => setSubdomainPrefix(event.target.value)} />
                                <span className="inline-flex max-w-[48%] select-none items-center truncate rounded-r-md border border-l-0 border-slate-200 bg-white px-3 font-mono text-sm text-slate-600">.{normalizedDomainSuffix}</span>
                              </div>
                              <Button size="sm" className="shrink-0 font-medium" disabled={savingHost || subdomainPrefixInvalid} onClick={() => void saveHost()}>保存</Button>
                            </div>
                            <p className="mt-2 break-all text-xs font-semibold leading-5 text-slate-500">{subdomainPrefix ? `${subdomainPrefix}.${normalizedDomainSuffix}` : "留空表示不绑定专属子域名。"}</p>
                            {subdomainPrefixInvalid ? <p className="mt-1 text-xs font-semibold text-red-700">子域名前缀格式不正确。</p> : null}
                            <button type="button" className="mt-2 text-xs font-semibold text-blue-700 underline" onClick={() => setHostDraft(selectedTenant.host && !hostDraftIsUnderSuffix ? selectedTenant.host : "custom.example.com")}>改用自定义域名</button>
                          </>
                        ) : (
                          <>
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <Input placeholder="wall.example.com 或 localhost:5180" value={hostDraft} onChange={(event) => setHostDraft(event.target.value)} />
                              <Button size="sm" className="shrink-0 font-medium" disabled={savingHost} onClick={() => void saveHost()}>保存</Button>
                            </div>
                            {normalizedDomainSuffix ? <button type="button" className="mt-2 text-xs font-semibold text-blue-700 underline" onClick={() => setHostDraft("")}>改用 .{normalizedDomainSuffix} 子域名</button> : null}
                          </>
                        )}
                      </section>

                      <section className="rounded-md border border-slate-200 bg-white p-4 2xl:col-span-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 font-bold text-slate-950">
                            <BotIcon className="size-4" />
                            机器人与发布目标
                          </div>
                          <Badge variant="outline">{selectedTenant.bots.length} 个墙号</Badge>
                        </div>
                        <div className="mt-3 grid gap-2 xl:grid-cols-2">
                          {selectedTenant.bots.length > 0 ? selectedTenant.bots.map((bot) => <TenantBotCard key={bot.id} bot={bot} />) : <p className="rounded-md bg-slate-50 px-3 py-6 text-center text-sm font-bold text-slate-500 xl:col-span-2">当前校园墙还没有配置机器人。</p>}
                        </div>
                      </section>

                      {isSystemMode ? (
                        <section className="rounded-md border border-rose-200 bg-rose-50 p-4 2xl:col-span-2">
                          <div className="flex items-center gap-2 font-bold text-rose-700">
                            <Trash2Icon className="size-4" />
                            彻底删除校园墙
                          </div>
                          <p className="mt-2 text-sm leading-6 text-rose-700">
                            删除后该墙的稿件、成员关系、机器人配置、表白记录与图片都会被清除，且无法恢复
                            （平台审计日志会保留一条删除记录）。建议先导出备份。
                          </p>
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              setTenantDeleteConfirmName("");
                              setTenantDeleteAck(false);
                              setTenantDeleteOpen(true);
                            }}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            删除「{selectedTenant.name}」
                          </Button>
                        </section>
                      ) : null}
                    </div>
                    <p className="border-t border-slate-100 px-4 py-3 text-xs leading-5 text-slate-500">校园墙名称、访问标识、主题色、品牌名和公告由租户管理员维护；生命周期和专属域名由这里统一管理。</p>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : null}

          {activeSection === "users" ? (
            <Card className="rounded-lg">
              <CardContent className="p-4">
                <GlobalUsersTable
                  users={users}
                  loading={loadingUsers}
                  pagination={usersPagination}
                  keyword={userKeywordDraft}
                  selectedRoleFilters={selectedUserRoleFilters}
                  availableRoleFilters={availableRoleFilters}
                  mode={mode}
                  selectedTenantFilterId={userTenantFilterId}
                  tenants={visibleTenants}
                  onKeywordChange={(keyword) => {
                    setUserKeywordDraft(keyword);
                    setUserKeyword(keyword);
                    writeOpsUserListPreferences(mode, { keyword, tenantFilterId: userTenantFilterId, roleFilters: selectedUserRoleFilters });
                    setUserPage(1);
                  }}
                  onKeywordSearch={() => {
                    setUserKeyword(userKeywordDraft);
                    writeOpsUserListPreferences(mode, { keyword: userKeywordDraft, tenantFilterId: userTenantFilterId, roleFilters: selectedUserRoleFilters });
                    setUserPage(1);
                  }}
                  onKeywordClear={() => {
                    setUserKeywordDraft("");
                    setUserKeyword("");
                    writeOpsUserListPreferences(mode, { keyword: "", tenantFilterId: userTenantFilterId, roleFilters: selectedUserRoleFilters });
                    setUserPage(1);
                  }}
                  onClearRoleFilters={() => {
                    setSelectedUserRoleFilters([]);
                    writeOpsUserListPreferences(mode, { keyword: userKeyword, tenantFilterId: userTenantFilterId, roleFilters: [] });
                    setUserPage(1);
                  }}
                  onTenantFilterChange={changeUserTenantFilter}
                  onOpenAssignMembership={openMembershipDialog}
                  onRevokeMembership={revokeUserTenantMembership}
                  onPageChange={setUserPage}
                  onToggleRoleFilter={toggleUserRoleFilter}
                  currentUserId={currentUserId}
                  isSystemMode={isSystemMode}
                  userActionBusyKey={userActionBusyKey}
                  onToggleDisabled={(user) => void toggleUserDisabled(user)}
                  onOpenDelete={(user) => void openDeleteUserDialog(user)}
                />
              </CardContent>
            </Card>
          ) : null}

          {activeSection === "audit" ? (
            <Card className="rounded-lg">
              <CardContent className="p-4">
                <AuditLogTable logs={auditLogs} loading={loadingAudit} pagination={auditPagination} onPageChange={setAuditPage} />
              </CardContent>
            </Card>
          ) : null}

          {activeSection === "platform" && isSystemMode ? (
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(300px,0.65fr)_minmax(0,1.35fr)]">
              <Card className="h-fit rounded-lg">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 font-bold text-slate-950">
                    <Globe2Icon className="size-4" />
                    管理端 host
                    {loadingSettings ? <span className="ml-auto size-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" /> : null}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-500">用户从这个域名访问时，登录页会开放邮箱注册入口，注册后自动获得运营管理员身份。</p>
                  <div className="mt-4 grid gap-2">
                    <Input placeholder="app.campux.top 或 localhost:5180" value={managementHostDraft} onChange={(event) => setManagementHostDraft(event.target.value)} />
                    <Button className="font-medium" disabled={savingManagementHost} onClick={() => void saveManagementHost()}>保存管理端 host</Button>
                  </div>
                </CardContent>
              </Card>
              <OperationsAdminAccessPanel
                users={operationsAdmins}
                tenants={visibleTenants}
                loading={loadingOperationsAdmins}
                busyKey={accessBusyKey}
                grantTenantByUserId={grantTenantByUserId}
                onGrantTenantChange={(userId, tenantId) => setGrantTenantByUserId((current) => ({ ...current, [userId]: tenantId }))}
                onGrant={grantOperationsAdminTenant}
                onRevoke={revokeOperationsAdminTenant}
              />
            </div>
          ) : null}
        </section>
      </div>

      <Dialog open={tenantCreateOpen} onOpenChange={(open) => !creatingTenant && setTenantCreateOpen(open)}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          onEscapeKeyDown={(event) => creatingTenant && event.preventDefault()}
          onInteractOutside={(event) => creatingTenant && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>新建校园墙</DialogTitle>
            <DialogDescription>创建后会自动打开接入引导；访问标识创建后不可修改。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 px-5">
            <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
              校园墙名称
              <Input placeholder="例如：广府校园墙" value={tenantForm.name} onChange={(event) => setTenantForm({ ...tenantForm, name: event.target.value })} />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
              访问标识
              <div className="flex gap-2">
                <Input placeholder="例如 gzhu-wall" value={tenantForm.slug} maxLength={tenantSlugMaxLength} aria-invalid={slugLengthInvalid || slugFormatInvalid || slugAlreadyUsed} onChange={(event) => setTenantForm({ ...tenantForm, slug: event.target.value })} />
                <Button type="button" variant="outline" size="icon" title="重新生成访问标识" className="shrink-0" onClick={() => setTenantForm({ ...tenantForm, slug: generateWallSlug(existingTenantSlugs) })}><RefreshCwIcon className="size-4" /></Button>
              </div>
            </label>
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-semibold leading-5 text-blue-900">
              <p>{tenantSlugHint}</p>
              {expectedTenantHost ? <p className="mt-1 break-all">{expectedTenantHostLabel}：<span className="font-mono">{expectedTenantHost}</span></p> : <p className="mt-1">配置自动域名后，这里会显示完整的预计访问域名。</p>}
              <p className="mt-1 text-blue-700">规则：4-16 个字符，只能使用小写字母、数字和连字符，且不能以连字符开头或结尾。</p>
              {slugLengthInvalid ? <p className="mt-1 text-red-700">访问标识需要 4 到 16 个字符。</p> : null}
              {slugFormatInvalid ? <p className="mt-1 text-red-700">访问标识格式不正确。</p> : null}
              {slugAlreadyUsed ? <p className="mt-1 text-red-700">这个访问标识已经被使用。</p> : null}
              {expectedHostAlreadyUsed ? <p className="mt-1 text-red-700">这个访问域名已经被使用。</p> : null}
            </div>
            <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
              专属域名 <span className="font-normal text-slate-400">可选</span>
              <Input placeholder="留空由平台自动分配" value={tenantForm.host} onChange={(event) => setTenantForm({ ...tenantForm, host: event.target.value })} />
            </label>
            <div className="grid gap-1.5 text-sm font-semibold text-slate-700">
              <label htmlFor="ops-tenant-theme-color">主题色</label>
              <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-2">
                <input aria-label="选择主题色" type="color" className="h-9 w-12 cursor-pointer rounded-md border border-slate-200 bg-white p-1" value={tenantForm.themeColor} onChange={(event) => setTenantForm({ ...tenantForm, themeColor: event.target.value })} />
                <Input id="ops-tenant-theme-color" aria-label="主题色十六进制值" value={tenantForm.themeColor} onChange={(event) => setTenantForm({ ...tenantForm, themeColor: event.target.value })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={creatingTenant} onClick={() => setTenantCreateOpen(false)}>取消</Button>
            <Button disabled={creatingTenant || enteringTenantId.length > 0 || tenantForm.name.trim().length === 0 || tenantFormSlug.length === 0 || tenantFormInvalid} onClick={() => void createTenant()}>
              <PlusIcon data-icon="inline-start" />
              {creatingTenant ? "创建中..." : "创建并继续接入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tenantDeleteOpen} onOpenChange={(open) => !deletingTenant && setTenantDeleteOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>彻底删除校园墙</DialogTitle>
            <DialogDescription>
              这个操作不可恢复。请先导出备份，再输入校园墙名称确认。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <p>
                要删除的校园墙：<span className="font-semibold text-slate-900">{selectedTenant?.name}</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                包含 {selectedTenant?.postCount ?? 0} 篇稿件、{selectedTenant?.memberCount ?? 0} 位成员、
                {selectedTenant?.botAccountCount ?? 0} 个墙号。
              </p>
            </div>
            <a
              className="text-sm font-semibold text-blue-700 underline"
              href={`/api/system/tenants/${selectedTenant?.id ?? ""}/export`}
            >
              ① 下载该校园墙的数据备份（JSON）
            </a>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={tenantDeleteAck}
                onChange={(event) => setTenantDeleteAck(event.target.checked)}
              />
              <span>我已保存上面的备份，并理解删除后无法恢复</span>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              ② 输入校园墙名称确认
              <Input
                value={tenantDeleteConfirmName}
                placeholder={selectedTenant?.name ?? ""}
                onChange={(event) => setTenantDeleteConfirmName(event.target.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={deletingTenant} onClick={() => setTenantDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={
                deletingTenant
                || !tenantDeleteAck
                || !selectedTenant
                || tenantDeleteConfirmName.trim() !== selectedTenant.name
              }
              onClick={() => void deleteSelectedTenant()}
            >
              {deletingTenant ? "删除中…" : "确认彻底删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteUserTarget)} onOpenChange={(open) => !open && !deletingUser && setDeleteUserTarget(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>
              先确认这个账号关联了什么，再决定这些数据怎么处理。删除后无法恢复（平台审计日志会保留一条记录）。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <p className="font-semibold text-slate-900">
                {deleteUserTarget?.displayName ?? "未设置昵称"}
                <span className="ml-2 font-normal text-slate-500">
                  {deleteUserTarget?.email ?? "无邮箱"} · QQ {deleteUserTarget?.qqUin}
                </span>
              </p>
              {deleteUserRelations ? (
                <p className="mt-1 text-xs text-slate-500">
                  创建于 {formatDateTime(deleteUserRelations.user.createdAt)}；
                  稿件 {deleteUserRelations.counts.posts} 篇、竞选 {deleteUserRelations.counts.campaigns} 个、
                  墙内身份 {deleteUserRelations.counts.memberships} 个、开墙申请 {deleteUserRelations.counts.applications} 条、
                  表白记录 {deleteUserRelations.counts.confessions} 条。
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">{deleteUserLoading ? "正在读取关联数据…" : "未能读取关联数据"}</p>
              )}
            </div>

            {deleteUserRelations && deleteUserRelations.administeredTenants.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">他正在运营这些校园墙：</p>
                <ul className="mt-1 grid gap-0.5 text-xs">
                  {deleteUserRelations.administeredTenants.map((tenant) => (
                    <li key={tenant.id}>
                      {tenant.name}（{tenant.slug}，{tenant.postCount} 篇稿件 / {tenant.memberCount} 位成员）
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <fieldset className="grid gap-2 rounded-md border border-slate-200 p-3">
              <legend className="px-1 text-xs font-semibold text-slate-600">他发过的稿件与竞选怎么处理？</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={deleteUserPosts === "delete"}
                  onChange={() => setDeleteUserPosts("delete")}
                />
                <span>
                  一起删除（含图片附件）
                  <span className="block text-xs text-slate-500">彻底删除选项：稿件、竞选及其图片一并清除。</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={deleteUserPosts === "keep"}
                  onChange={() => setDeleteUserPosts("keep")}
                />
                <span>
                  保留稿件，转交给「已注销账号」
                  <span className="block text-xs text-slate-500">墙上的内容继续可见，只是署名变成已注销账号。</span>
                </span>
              </label>
            </fieldset>

            <fieldset className="grid gap-2 rounded-md border border-slate-200 p-3">
              <legend className="px-1 text-xs font-semibold text-slate-600">他运营的校园墙怎么处理？</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={deleteUserTenants === "keep"}
                  onChange={() => setDeleteUserTenants("keep")}
                />
                <span>
                  保留校园墙，管理员移交给我
                  <span className="block text-xs text-slate-500">推荐：墙和里面的稿件、用户都不受影响，你成为该墙管理员。</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={deleteUserTenants === "delete"}
                  onChange={() => setDeleteUserTenants("delete")}
                />
                <span>
                  连同校园墙一起彻底删除
                  <span className="block text-xs text-rose-600">慎用：该墙的稿件、成员关系、机器人配置与图片都会被清除。</span>
                </span>
              </label>
            </fieldset>

            <label className="grid gap-1 text-sm font-medium">
              输入该账号的邮箱或昵称确认
              <Input
                value={deleteUserConfirm}
                placeholder={deleteUserTarget?.email ?? deleteUserTarget?.displayName ?? deleteUserTarget?.qqUin ?? ""}
                onChange={(event) => setDeleteUserConfirm(event.target.value)}
              />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={deletingUser} onClick={() => setDeleteUserTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={
                deletingUser
                || !deleteUserTarget
                || !deleteUserRelations
                || ![deleteUserTarget.email, deleteUserTarget.displayName, deleteUserTarget.qqUin]
                  .filter((value): value is string => Boolean(value))
                  .includes(deleteUserConfirm.trim())
              }
              onClick={() => void confirmDeleteUser()}
            >
              {deletingUser ? "删除中…" : deleteUserTenants === "delete" ? "彻底删除账号与校园墙" : "删除账号"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(membershipDialogUser)} onOpenChange={(open) => !open && setMembershipDialogUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加租户身份</DialogTitle>
            <DialogDescription>
              {isSystemMode
                ? `给 ${membershipDialogUser?.displayName ?? membershipDialogUser?.qqUin ?? "用户"} 添加平台身份，或添加/更新某个校园墙内的身份。`
                : `给 ${membershipDialogUser?.displayName ?? membershipDialogUser?.qqUin ?? "用户"} 添加/更新你负责校园墙内的身份。`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 px-5">
            <label className="text-sm font-semibold text-slate-700">
              校园墙
              <Select value={membershipForm.tenantId} onValueChange={(tenantId) => setMembershipForm({ ...membershipForm, tenantId })}>
                <SelectTrigger className="mt-1 w-full bg-white" disabled={membershipForm.role === "system_operator" || membershipForm.role === "operations_admin"}>
                  <SelectValue placeholder="选择校园墙" />
                </SelectTrigger>
                <SelectContent>
                  {visibleTenants.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {statusLabels[tenant.status]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-sm font-semibold text-slate-700">
              身份
              <Select value={membershipForm.role} onValueChange={(role) => setMembershipForm({ ...membershipForm, role: role as TenantRole | SystemRole })}>
                <SelectTrigger className="mt-1 w-full bg-white"><SelectValue placeholder="选择身份" /></SelectTrigger>
                <SelectContent>
                  {isSystemMode ? (
                    <>
                      <SelectItem value="operations_admin" disabled={membershipDialogUser?.systemRole === "system_operator"}>运营管理员（平台）</SelectItem>
                      <SelectItem value="system_operator">系统运维（全局）</SelectItem>
                    </>
                  ) : null}
                  <SelectItem value="submitter">用户</SelectItem>
                  <SelectItem value="reviewer">审核员</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
              {membershipDialogUser?.systemRole === "system_operator"
                ? "系统运维已经拥有最高平台权限，不会被运营管理员身份覆盖。"
                : isSystemMode
                  ? "平台身份不需要选择校园墙；租户身份如果已存在，保存后会直接更新。"
                  : "运营管理员只能调整自己负责校园墙内的用户身份。"}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={assigningMembership} onClick={() => setMembershipDialogUser(null)}>取消</Button>
            <Button
              disabled={assigningMembership || (membershipForm.role === "operations_admin" && membershipDialogUser?.systemRole === "system_operator") || ((membershipForm.role !== "system_operator" && membershipForm.role !== "operations_admin") && !membershipForm.tenantId)}
              onClick={() => void assignMembership()}
            >
              <ShieldPlusIcon data-icon="inline-start" />
              保存身份
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OnboardingGuide({
  mode,
  hasTenants,
  selectedTenant,
  tenantDomainSuffix,
}: {
  mode: OpsPanelMode;
  hasTenants: boolean;
  selectedTenant: SystemTenant | undefined;
  tenantDomainSuffix: string | null;
}) {
  const isSystemMode = mode === "system";
  const botReady = Boolean(selectedTenant?.ready);
  const publishReady = Boolean(selectedTenant?.bots.some((bot) => bot.publishTargets.length > 0));
  const hostReady = Boolean(selectedTenant?.host);
  const steps = [
    {
      title: isSystemMode ? "开放管理端注册" : "创建校园墙",
      detail: isSystemMode
        ? "设置管理端 host，例如 app.campux.top，让墙号运营者可以用邮箱注册运营管理员账号。"
        : tenantDomainSuffix
          ? `确认校园墙名称和访问标识。访问标识会成为 ${tenantDomainSuffix} 下的子域名前缀，创建后不可修改。`
          : "确认校园墙名称和访问标识。访问标识会用于 URL 和内部标识，创建后不可修改。",
      done: isSystemMode ? true : hasTenants,
    },
    {
      title: isSystemMode ? "分配运营资源" : "进入开通引导",
      detail: isSystemMode ? "在运营管理员资源里给账号授权可管理的校园墙；系统运维仍保留全局能力。" : "创建校园墙后会自动打开引导；之后也可以点「作为管理员进入」继续未完成的接入流程。",
      done: isSystemMode ? true : botReady,
    },
    {
      title: "接入墙号机器人",
      detail: "在开通引导里用墙号 QQ 登录 NapCat，粘贴连接地址，连接成功即完成认证、校园墙就绪。",
      done: botReady,
    },
    {
      title: "配置发布到 QQ 空间",
      detail: "在引导里扫码登录墙号 QQ 空间，确认登录态可用后即可开始审核发布。",
      done: publishReady,
    },
    {
      title: "专属域名",
      detail: "官方部署会在开墙时自动分配子域名；也可以由系统运维在这里手动维护。",
      done: hostReady,
    },
  ];

  return (
    <details className="rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
          <div>
            <p className="text-sm font-bold text-slate-950">{isSystemMode ? "平台交付流程" : "自助开墙流程"}</p>
            <p className="mt-1 text-sm leading-6 text-slate-500">首次交付或自助开墙时展开查看流程。</p>
            {!isSystemMode && hasTenants ? (
              <p className="mt-1 text-xs font-bold text-blue-700">创建完成后会自动打开接入引导；之后也可以点击校园墙的“作为管理员进入”继续未完成的流程。</p>
            ) : null}
          </div>
          {selectedTenant ? <Badge variant="secondary">{selectedTenant.name}</Badge> : <Badge variant="outline">帮助</Badge>}
      </summary>
      <div className="grid gap-2 border-t border-slate-100 p-4 lg:grid-cols-5">
          {steps.map((step, index) => (
            <div key={step.title} className={`rounded-md border p-3 ${step.done ? "border-green-200 bg-green-50/70" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-center gap-2">
                <span className={`grid size-6 place-items-center rounded-full text-xs font-black ${step.done ? "bg-green-600 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>
                  {step.done ? <CheckIcon className="size-3.5" /> : index + 1}
                </span>
                <p className="text-sm font-bold text-slate-950">{step.title}</p>
              </div>
              <p className="mt-2 text-xs font-semibold leading-5 text-slate-500">{step.detail}</p>
            </div>
          ))}
      </div>
    </details>
  );
}

function TenantRuntimeStrip({ tenant }: { tenant: SystemTenant }) {
  const runtime = summarizeTenantRuntime(tenant);
  const online = runtime.onlineBots > 0;
  const targetTone = runtime.unavailableTargets > 0
    ? "border-red-200 bg-red-50 text-red-700"
    : runtime.readyTargets > 0
      ? "border-green-200 bg-green-50 text-green-700"
      : "border-slate-200 bg-white text-slate-500";

  return (
    <span className="mt-2 grid gap-1 border-t border-slate-200/70 pt-2 text-[10px] font-semibold text-slate-500">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${online ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
          {online ? <WifiIcon className="size-3" /> : <WifiOffIcon className="size-3" />}
          机器人 {runtime.onlineBots}/{runtime.totalBots} 在线
        </span>
        <span className={`rounded-full border px-1.5 py-0.5 ${targetTone}`}>
          {runtime.totalTargets === 0
            ? "发布目标未配置"
            : runtime.unavailableTargets > 0
              ? `发布目标 ${runtime.unavailableTargets} 异常`
              : `发布目标 ${runtime.readyTargets}/${runtime.totalTargets} 正常`}
        </span>
      </span>
      <span>最后连接：{formatDateTime(runtime.lastConnectedAt)}</span>
    </span>
  );
}

function TenantBotCard({ bot }: { bot: SystemTenant["bots"][number] }) {
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{bot.displayName}</p>
          <p className="mt-0.5 text-xs font-bold text-slate-500">QQ {bot.qqUin}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge className={`gap-1 rounded-full shadow-none ${bot.connection.online ? "bg-green-50 text-green-800 ring-1 ring-green-200" : "bg-slate-200 text-slate-600"}`}>
            {bot.connection.online ? <WifiIcon className="size-3" /> : <WifiOffIcon className="size-3" />}
            {bot.connection.online ? "在线" : "离线"}
          </Badge>
          {!bot.enabled ? <Badge variant="outline">停用</Badge> : null}
        </div>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
        <span>审核群：{bot.reviewGroupId ?? "未配置"}</span>
        <span>最后连接：{formatDateTime(bot.lastSeenAt)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {bot.publishTargets.length > 0 ? (
          bot.publishTargets.map((target) => (
            <Badge
              key={target.id}
              variant="outline"
              className={`gap-1 ${target.status === "ready" ? "border-green-200 bg-green-50 text-green-700" : target.status === "unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-500"}`}
            >
              {target.displayName}
              {target.status === "ready" ? " · 正常" : target.status === "unavailable" ? " · 登录态异常" : " · 停用"}
              {target.required ? " · 必发" : ""}
            </Badge>
          ))
        ) : (
          <span className="text-xs font-bold text-slate-400">没有发布目标</span>
        )}
      </div>
    </div>
  );
}

function OperationsAdminAccessPanel({
  users,
  tenants,
  loading,
  busyKey,
  grantTenantByUserId,
  onGrantTenantChange,
  onGrant,
  onRevoke,
}: {
  users: SystemUser[];
  tenants: SystemTenant[];
  loading: boolean;
  busyKey: string;
  grantTenantByUserId: Record<string, string>;
  onGrantTenantChange: (userId: string, tenantId: string) => void;
  onGrant: (user: SystemUser) => void;
  onRevoke: (user: SystemUser, membershipId: string, tenantName: string) => void;
}) {
  const visibleTenantIds = useMemo(() => new Set(tenants.map((tenant) => tenant.id)), [tenants]);

  return (
    <Card className="rounded-lg">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold text-slate-900">
            <ShieldPlusIcon className="size-4" />
            运营管理员资源
          </div>
          {loading ? <span className="size-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" /> : null}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          系统运维在这里查看运营管理员身份，并配置他们可以管理哪些校园墙资源。
        </p>
        <div className="mt-4 grid max-h-[calc(100dvh-260px)] gap-3 overflow-y-auto pr-1 2xl:grid-cols-2">
          {users.map((user) => {
            const adminMemberships = user.memberships.filter((membership) => membership.role === "admin" && visibleTenantIds.has(membership.tenant.id));
            const assignedTenantIds = new Set(adminMemberships.map((membership) => membership.tenant.id));
            const availableTenants = tenants.filter((tenant) => !assignedTenantIds.has(tenant.id));
            const grantTenantId = grantTenantByUserId[user.id] ?? "";

            return (
              <div key={user.id} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-950">{user.displayName ?? "未设置昵称"}</p>
                      <Badge variant="secondary">运营管理员</Badge>
                    </div>
                    <p className="mt-0.5 text-xs font-bold text-slate-500">QQ {user.qqUin}</p>
                    {user.email ? <p className="mt-0.5 text-xs font-bold text-slate-500">{user.email}</p> : null}
                  </div>
                  <div className="flex min-w-[260px] flex-1 flex-col gap-2 sm:max-w-md sm:flex-row">
                    <Select value={grantTenantId} onValueChange={(tenantId) => onGrantTenantChange(user.id, tenantId)}>
                      <SelectTrigger className="h-9 bg-white">
                        <SelectValue placeholder={availableTenants.length > 0 ? "选择要授权的校园墙" : "已拥有全部校园墙"} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableTenants.map((tenant) => (
                          <SelectItem key={tenant.id} value={tenant.id}>
                            {tenant.name} · {statusLabels[tenant.status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={!grantTenantId || busyKey === `grant:${user.id}:${grantTenantId}`}
                      onClick={() => onGrant(user)}
                    >
                      授权资源
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {adminMemberships.length > 0 ? (
                    adminMemberships.map((membership) => (
                      <span key={membership.id} className="inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">
                        {membership.tenant.name}
                        <button
                          type="button"
                          className="ml-1 inline-flex size-5 items-center justify-center rounded hover:bg-blue-100 disabled:opacity-50"
                          disabled={busyKey === `revoke:${membership.id}`}
                          onClick={() => onRevoke(user, membership.id, membership.tenant.name)}
                          aria-label={`移除 ${membership.tenant.name} 访问权`}
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      </span>
                    ))
                  ) : (
                    <span className="text-xs font-semibold text-slate-500">暂未授权任何校园墙资源。</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {users.length === 0 && !loading ? <p className="mt-4 text-sm font-semibold text-slate-500">当前没有运营管理员。</p> : null}
      </CardContent>
    </Card>
  );
}

function GlobalUsersTable({
  users,
  loading,
  pagination,
  keyword,
  selectedRoleFilters,
  availableRoleFilters,
  mode,
  selectedTenantFilterId,
  tenants,
  onKeywordChange,
  onKeywordClear,
  onKeywordSearch,
  onClearRoleFilters,
  onTenantFilterChange,
  onOpenAssignMembership,
  onRevokeMembership,
  onPageChange,
  onToggleRoleFilter,
  currentUserId,
  isSystemMode,
  userActionBusyKey,
  onToggleDisabled,
  onOpenDelete,
}: {
  users: SystemUser[];
  loading: boolean;
  pagination: Pagination;
  keyword: string;
  selectedRoleFilters: SystemUserRoleFilter[];
  availableRoleFilters: Array<{ value: SystemUserRoleFilter; label: string }>;
  mode: OpsPanelMode;
  selectedTenantFilterId: string;
  tenants: SystemTenant[];
  onKeywordChange: (keyword: string) => void;
  onKeywordClear: () => void;
  onKeywordSearch: () => void;
  onClearRoleFilters: () => void;
  onTenantFilterChange: (tenantId: string) => void;
  onOpenAssignMembership: (user: SystemUser) => void;
  onRevokeMembership: (user: SystemUser, membership: SystemUser["memberships"][number]) => void;
  onPageChange: (page: number) => void;
  onToggleRoleFilter: (role: SystemUserRoleFilter) => void;
  currentUserId: string;
  isSystemMode: boolean;
  userActionBusyKey: string;
  onToggleDisabled: (user: SystemUser) => void;
  onOpenDelete: (user: SystemUser) => void;
}) {
  const visibleTenantIds = useMemo(() => new Set(tenants.map((tenant) => tenant.id)), [tenants]);

  if (loading && users.length === 0) {
    return <InlineLoading title={mode === "system" ? "正在加载全局用户..." : "正在加载墙内用户..."} />;
  }

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2">
          <SearchIcon className="size-4 shrink-0 text-slate-400" />
          <Input
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            placeholder="按用户 ID、QQ 号或名称搜索账号"
            value={keyword}
            onChange={(event) => onKeywordChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onKeywordSearch();
              }
            }}
          />
        </div>
        {keyword ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onKeywordClear}>
            清除搜索
          </Button>
        ) : null}
        <Button variant="outline" size="sm" className="shrink-0" onClick={onKeywordSearch}>
          搜索
        </Button>
      </div>
      <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <FilterIcon className="size-4" />
            按租户身份筛选
          </div>
          {selectedRoleFilters.length > 0 ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClearRoleFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={selectedTenantFilterId || "all"} onValueChange={onTenantFilterChange}>
            <SelectTrigger className="w-full bg-white sm:w-72">
              <SelectValue placeholder="选择校园墙" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{mode === "system" ? "全部用户" : "全部可管理用户"}</SelectItem>
              {tenants.map((tenant) => (
                <SelectItem key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs font-semibold text-slate-500">
            {mode === "system"
              ? selectedTenantFilterId
                ? "筛选该校园墙内的具体身份，也可叠加平台身份"
                : "可直接筛选平台身份；选择校园墙后可筛选租户身份"
              : selectedTenantFilterId
                ? "筛选该校园墙内的具体身份"
                : "筛选你可管理校园墙内的具体身份"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {availableRoleFilters.map((filter) => {
            const active = selectedRoleFilters.includes(filter.value);
            return (
              <Button
                key={filter.value}
                type="button"
                variant={active ? "secondary" : "outline"}
                disabled={mode === "system" && !selectedTenantFilterId && filter.value !== "system_operator" && filter.value !== "operations_admin"}
                size="sm"
                className={active ? "h-8 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50" : "h-8 bg-white"}
                onClick={() => onToggleRoleFilter(filter.value)}
              >
                {active ? <CheckIcon data-icon="inline-start" /> : null}
                {filter.label}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200">
        {users.map((user) => {
          const visibleMemberships = user.memberships.filter((membership) => visibleTenantIds.has(membership.tenant.id));
          return (
            <div key={user.id} className="grid gap-3 border-b border-slate-100 bg-white p-3 last:border-b-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(150px,0.6fr)]">
              <div className="flex min-w-0 items-center gap-3">
                <img className="size-10 rounded-full border border-slate-200 bg-slate-50" src={`https://q1.qlogo.cn/g?b=qq&nk=${user.qqUin}&s=100`} alt="" loading="lazy" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-950">{user.displayName ?? "未设置昵称"}</p>
                  <p className="mt-0.5 text-xs font-bold text-slate-500">QQ {user.qqUin}</p>
                  {user.email ? <p className="mt-0.5 truncate text-xs font-bold text-slate-500">{user.email}</p> : null}
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-1.5">
                  {user.systemRole === "operations_admin" ? <Badge variant="secondary">运营管理员</Badge> : null}
                  {user.systemRole === "system_operator" ? <Badge variant="secondary">系统运维</Badge> : null}
                  {user.isTestAccount ? <Badge variant="outline">测试账号</Badge> : null}
                  {user.disabledAt ? <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">已停用</Badge> : null}
                  {visibleMemberships.length === 0 ? <Badge variant="outline">未加入租户</Badge> : null}
                  {visibleMemberships.slice(0, 4).map((membership) => (
                    <span key={membership.id} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                      {membership.tenant.name} · {roleLabels[membership.role]}
                      <button
                        type="button"
                        className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        onClick={() => onRevokeMembership(user, membership)}
                        aria-label={`删除 ${membership.tenant.name} 的${roleLabels[membership.role]}身份`}
                      >
                        <Trash2Icon className="size-3" />
                      </button>
                    </span>
                  ))}
                  {visibleMemberships.length > 4 ? <Badge variant="outline">+{visibleMemberships.length - 4}</Badge> : null}
                </div>
              </div>
              <div className="text-xs text-slate-500">
                <p>创建：{formatDateTime(user.createdAt)}</p>
                <p className="mt-1">加入：{visibleMemberships.length} 个校园墙</p>
                <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-xs" disabled={tenants.length === 0} onClick={() => onOpenAssignMembership(user)}>
                  <ShieldPlusIcon data-icon="inline-start" />
                  添加身份
                </Button>
                {isSystemMode && user.id !== currentUserId && user.systemRole !== "system_operator" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={userActionBusyKey === `disable:${user.id}`}
                      onClick={() => onToggleDisabled(user)}
                    >
                      {user.disabledAt ? "恢复账号" : "停用账号"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-rose-200 px-2 text-xs text-rose-700 hover:bg-rose-50"
                      onClick={() => onOpenDelete(user)}
                    >
                      删除账号
                    </Button>
                  </div>
                ) : null}
                {user.disabledAt && user.disabledReason ? (
                  <p className="mt-1 text-xs text-rose-600">停用原因：{user.disabledReason}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {users.length === 0 ? <p className="px-3 py-8 text-center text-sm font-bold text-slate-500">没有用户。</p> : null}
      <PaginationControls pagination={pagination} busy={loading} onPageChange={onPageChange} />
    </div>
  );
}

function AuditLogTable({
  logs,
  loading,
  pagination,
  onPageChange,
}: {
  logs: AuditLogItem[];
  loading: boolean;
  pagination: Pagination;
  onPageChange: (page: number) => void;
}) {
  if (loading && logs.length === 0) {
    return <InlineLoading title="正在加载审计日志..." />;
  }

  return (
    <div>
      <div className="overflow-hidden rounded-md border border-slate-200">
        {logs.map((log) => (
          <div key={log.id} className="grid gap-3 border-b border-slate-100 bg-white p-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(160px,0.7fr)]">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-950">{log.action}</p>
              <p className="mt-1 text-xs font-bold text-slate-500">
                {log.targetType}
                {log.targetId ? ` · ${log.targetId}` : ""}
              </p>
            </div>
            <div className="min-w-0 text-xs text-slate-500">
              <p>
                租户：<span className="font-semibold text-slate-700">{log.tenant?.name ?? "全局"}</span>
              </p>
              <p className="mt-1">
                操作人：<span className="font-semibold text-slate-700">{log.actor?.displayName ?? log.actor?.qqUin ?? "系统"}</span>
              </p>
              <p className="mt-1 truncate">详情：{formatDetail(log.detail)}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ClockIcon className="size-4" />
              {formatDateTime(log.createdAt)}
            </div>
          </div>
        ))}
      </div>
      {logs.length === 0 ? <p className="px-3 py-8 text-center text-sm font-bold text-slate-500">没有审计日志。</p> : null}
      <PaginationControls pagination={pagination} busy={loading} onPageChange={onPageChange} />
    </div>
  );
}

function InlineLoading({ title }: { title: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-3 text-sm font-bold text-slate-500">
      <span className="size-6 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" />
      {title}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-slate-100 bg-white px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
    </div>
  );
}

function TenantMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-[11px] font-semibold text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function MetricCard({ title, value, icon: Icon, accent }: { title: string; value: number | string; icon: typeof ActivityIcon; accent: "blue" | "green" | "violet" | "amber" | "rose" | "slate" }) {
  const accentClass = {
    blue: "product-accent-blue",
    green: "product-accent-green",
    violet: "product-accent-violet",
    amber: "product-accent-amber",
    rose: "product-accent-rose",
    slate: "border-slate-200 bg-slate-100 text-slate-700",
  }[accent];

  return (
    <div className={`min-w-0 rounded-lg border px-3 py-3 ${accentClass}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{title}</span>
      </div>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** 运维面板里的简短时间显示：8/31 14:05。 */
function formatOpsTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "暂无";
  }
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDetail(detail: unknown) {
  if (!detail) {
    return "无";
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return "无法显示";
  }
}
