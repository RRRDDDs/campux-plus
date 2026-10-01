import type { Prisma } from "@campux/db";
import { prisma } from "./prisma";

/**
 * 开墙申请。
 *
 * 运营者在注册时提交申请，系统运维审核通过后才允许创建自己的校园墙。
 * 系统运维（system_operator）不受限制；每个通过审核的账号默认只能开 1 个墙
 * （判定方式：当前没有任何以 admin 身份参与的墙）。
 */

export type TenantApplicationStatus = "pending" | "approved" | "rejected";

export type TenantApplicationSummary = {
  id: string;
  wallName: string;
  school: string | null;
  contact: string | null;
  reason: string | null;
  status: TenantApplicationStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

type ApplicationRow = {
  id: string;
  wallName: string;
  school: string | null;
  contact: string | null;
  reason: string | null;
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

export function normalizeApplicationStatus(value: string | null | undefined): TenantApplicationStatus {
  return value === "approved" || value === "rejected" ? value : "pending";
}

export function toTenantApplicationSummary(row: ApplicationRow): TenantApplicationSummary {
  return {
    id: row.id,
    wallName: row.wallName,
    school: row.school,
    contact: row.contact,
    reason: row.reason,
    status: normalizeApplicationStatus(row.status),
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getLatestTenantApplication(
  userId: string,
  client: Pick<Prisma.TransactionClient, "tenantApplication"> = prisma,
) {
  return client.tenantApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/** 该用户当前正在运营（admin 身份）的墙数量，用于限制「通过后只能开 1 个墙」。 */
export async function countAdministeredTenants(
  userId: string,
  client: Pick<Prisma.TransactionClient, "tenantMembership"> = prisma,
) {
  return client.tenantMembership.count({
    where: {
      userId,
      role: "admin",
      tenant: { status: { not: "archived" } },
    },
  });
}

export type TenantCreationPermission =
  | { allowed: true; reason: "system_operator" }
  | { allowed: true; reason: "approved"; application: ApplicationRow }
  | { allowed: false; code: "no_application" | "pending" | "rejected" | "quota"; message: string };

/**
 * 判断某个账号是否被允许创建校园墙。
 * 前端据此显示引导，后端在创建接口里强制校验（不能只靠前端）。
 */
export async function resolveTenantCreationPermission(user: {
  id: string;
  systemRole: string | null;
}): Promise<TenantCreationPermission> {
  if (user.systemRole === "system_operator") {
    return { allowed: true, reason: "system_operator" };
  }

  const application = await getLatestTenantApplication(user.id);
  if (!application) {
    return {
      allowed: false,
      code: "no_application",
      message: "你需要先提交开墙申请，通过系统运维审核后才能创建校园墙。",
    };
  }

  const status = normalizeApplicationStatus(application.status);
  if (status === "pending") {
    return {
      allowed: false,
      code: "pending",
      message: "你的开墙申请正在审核中，通过后即可创建校园墙。",
    };
  }
  if (status === "rejected") {
    return {
      allowed: false,
      code: "rejected",
      message: application.reviewNote
        ? `你的开墙申请未通过：${application.reviewNote}`
        : "你的开墙申请未通过，可以补充信息后重新提交。",
    };
  }

  const administered = await countAdministeredTenants(user.id);
  if (administered > 0) {
    return {
      allowed: false,
      code: "quota",
      message: "每个账号目前只能运营一个校园墙。如需开通更多，请联系系统运维。",
    };
  }

  return { allowed: true, reason: "approved", application };
}

export type SubmitApplicationInput = {
  userId: string;
  wallName: string;
  school?: string | null;
  contact?: string | null;
  reason?: string | null;
};

export type SubmitApplicationResult =
  | { ok: true; application: TenantApplicationSummary }
  | { ok: false; code: "already_pending" | "already_approved" | "quota"; message: string };

/** 提交（或重新提交）开墙申请。被拒绝后可以再次提交，历史记录保留。 */
export async function submitTenantApplication(input: SubmitApplicationInput): Promise<SubmitApplicationResult> {
  const latest = await getLatestTenantApplication(input.userId);
  if (latest) {
    const status = normalizeApplicationStatus(latest.status);
    if (status === "pending") {
      return {
        ok: false,
        code: "already_pending",
        message: "你已经提交过开墙申请，正在等待审核，请耐心等待。",
      };
    }
    if (status === "approved" && await countAdministeredTenants(input.userId) > 0) {
      return {
        ok: false,
        code: "quota",
        message: "你已经在运营校园墙了；如需开通更多，请联系系统运维。",
      };
    }
  }

  const created = await prisma.tenantApplication.create({
    data: {
      userId: input.userId,
      wallName: input.wallName.trim(),
      school: input.school?.trim() || null,
      contact: input.contact?.trim() || null,
      reason: input.reason?.trim() || null,
      status: "pending",
    },
  });
  return { ok: true, application: toTenantApplicationSummary(created) };
}

export type ReviewApplicationResult =
  | { ok: true; application: TenantApplicationSummary }
  | { ok: false; code: "not_found" | "already_reviewed"; message: string };

/** 系统运维审核：通过 / 拒绝（可写备注，会展示给申请人）。 */
export async function reviewTenantApplication(options: {
  applicationId: string;
  reviewerId: string;
  action: "approve" | "reject";
  note?: string | null;
}): Promise<ReviewApplicationResult> {
  const application = await prisma.tenantApplication.findUnique({
    where: { id: options.applicationId },
  });
  if (!application) {
    return { ok: false, code: "not_found", message: "申请不存在" };
  }
  if (normalizeApplicationStatus(application.status) !== "pending") {
    return { ok: false, code: "already_reviewed", message: "该申请已经处理过了" };
  }

  const updated = await prisma.tenantApplication.update({
    where: { id: application.id },
    data: {
      status: options.action === "approve" ? "approved" : "rejected",
      reviewNote: options.note?.trim() || null,
      reviewedById: options.reviewerId,
      reviewedAt: new Date(),
    },
  });
  return { ok: true, application: toTenantApplicationSummary(updated) };
}
