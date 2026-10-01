import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CampuxConfig } from "@campux/config";
import { Prisma, TransactionIsolationLevel, createManyDedup } from "@campux/db";
import { z } from "zod";
import { requirePlatformAdmin } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { prisma } from "../lib/prisma";
import {
  assertTenantActivationAllowed,
  assertTenantMembershipRemovalAllowed,
  assertTenantMembershipRoleChangeAllowed,
  buildTenantAdminUserIds,
  isTransactionSerializationFailure,
  retryTransactionSerializationFailures,
  tenantAdminInvariantErrorResponse,
  updateTenantAfterAdminCheck,
} from "../lib/tenant-membership-removal";
import { normalizeTenantHost } from "../lib/tenant-host";
import { lockTenantRuntime } from "../lib/tenant-runtime-lease";
import {
  buildTenantDomainHost,
  hostIsUnderTenantSuffix,
  normalizeDomainSuffix,
  persistAfterTenantDomainReprovision,
  provisionTenantDomain,
  reprovisionTenantDomainWithCompensation,
  resolveDnsTargetHost,
  tenantDomainAutomationEnabled,
  TenantDomainCompensationError,
  TenantDomainProvisioningError,
} from "../lib/tenant-domain";
import { buildUserContainsSearch } from "../lib/user-search";
import { reviewTenantApplication, resolveTenantCreationPermission, toTenantApplicationSummary } from "../lib/tenant-application";
import { buildTenantExportBundle } from "../lib/tenant-export";
import { deleteAttachmentObjects } from "../lib/attachments";
import type { RuntimeQueue } from "../runtime/queue";
import type { OneBotRuntime } from "../runtime/onebot";
import type { EventBus, PluginEvent } from "@campux/plugin";

const tenantStatusSchema = z.enum(["active", "paused", "archived"]);

const tenantPatchSchema = z.object({
  status: tenantStatusSchema.optional(),
  host: z.string().max(255).nullable().optional(),
});

const systemSettingsPatchSchema = z.object({
  managementHost: z.string().max(255).nullable().optional(),
});

const tenantRoleSchema = z.enum(["submitter", "reviewer", "admin"]);
const platformAssignableRoleSchema = z.enum(["operations_admin", "system_operator", "submitter", "reviewer", "admin"]);

const userMembershipCreateSchema = z.object({
  tenantId: z.string().min(1).optional(),
  role: platformAssignableRoleSchema,
});

const tenantCreateSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(4).max(16).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  host: z.string().max(255).nullable().optional(),
  themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#42a5f5"),
  banner: z.string().max(200).default(""),
  botQqUin: z.string().regex(/^\d+$/).optional(),
});

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** 开墙申请列表筛选。 */
const tenantApplicationQuerySchema = z.object({
  status: z.enum(["all", "pending", "approved", "rejected"]).default("pending"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 系统运维审核开墙申请。 */
const tenantApplicationReviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(300).optional(),
});

/** 彻底删除校园墙：必须输入墙名确认，并先下载备份。 */
const tenantDeleteSchema = z.object({
  confirmName: z.string().trim().min(1, "请输入校园墙名称以确认删除"),
  backupAcknowledged: z.boolean(),
});

const systemUserRoleFilterSchema = platformAssignableRoleSchema;

const systemUsersQuerySchema = paginationQuerySchema.extend({
  q: z.string().max(80).optional(),
  roles: z.string().optional(),
  tenantId: z.string().optional(),
});

const defaultPostRules = [
  "不发布隐私信息、辱骂、人身攻击和未经确认的指控。",
  "寻物招领请写清地点、时间和联系方式。",
  "图片最多 9 张，审核通过后会同步到本校启用的 QQ 墙号。",
];

const defaultServices = [
  { title: "修改名称", description: "账户资料" },
  { title: "修改密码", description: "账号服务" },
  { title: "投稿规则", description: "查看本墙规范" },
  { title: "校园服务", description: "推荐入口" },
];

type SystemTenantRecord = {
  id: string;
  slug: string;
  host: string | null;
  name: string;
  status: z.infer<typeof tenantStatusSchema>;
  readyAt: Date | null;
  archiveWarningAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  botAccounts: Array<{
    id: string;
    platform: string;
    qqUin: bigint;
    displayName: string;
    enabled: boolean;
    reviewGroupId: string | null;
    lastSeenAt: Date | null;
    sessions: Array<{
      healthStatus: string;
    }>;
    publishTargets: Array<{
      id: string;
      type: string;
      displayName: string;
      enabled: boolean;
      required: boolean;
    }>;
  }>;
  _count: {
    botAccounts: number;
    posts: number;
    memberships: number;
  };
};

type BotConnectionStatusProvider = Pick<OneBotRuntime, "getBotConnectionStatus">;

export function toSystemTenant(tenant: SystemTenantRecord, oneBot?: BotConnectionStatusProvider) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    host: tenant.host,
    name: tenant.name,
    status: tenant.status,
    ready: tenant.readyAt !== null,
    readyAt: tenant.readyAt?.toISOString() ?? null,
    archiveWarningAt: tenant.archiveWarningAt?.toISOString() ?? null,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
    botAccountCount: tenant._count.botAccounts,
    postCount: tenant._count.posts,
    memberCount: tenant._count.memberships,
    bots: tenant.botAccounts.map((bot) => ({
      id: bot.id,
      platform: bot.platform,
      qqUin: bot.qqUin.toString(),
      displayName: bot.displayName,
      enabled: bot.enabled,
      reviewGroupId: bot.reviewGroupId,
      lastSeenAt: bot.lastSeenAt?.toISOString() ?? null,
      connection: bot.platform === "personal_qq"
        ? { online: bot.enabled, connectionCount: bot.enabled ? 1 : 0 }
        : oneBot?.getBotConnectionStatus(bot.qqUin.toString()) ?? { online: false, connectionCount: 0 },
      publishTargets: bot.publishTargets.map((target) => ({
        id: target.id,
        displayName: target.displayName,
        enabled: target.enabled,
        required: target.required,
        status: !bot.enabled || !target.enabled
          ? "disabled" as const
          : target.type !== "qzone" || bot.sessions[0]?.healthStatus === "available"
            ? "ready" as const
            : "unavailable" as const,
      })),
    })),
  };
}

type PlatformContext = Awaited<ReturnType<typeof requirePlatformAdmin>>;

function isSystemOperator(context: PlatformContext) {
  return context.user.systemRole === "system_operator";
}

function manageableTenantIds(context: PlatformContext) {
  if (isSystemOperator(context)) {
    return null;
  }

  return context.memberships.filter((membership) => membership.role === "admin").map((membership) => membership.tenantId);
}

function assertCanManageTenant(context: PlatformContext, tenantId: string, reply: FastifyReply) {
  const tenantIds = manageableTenantIds(context);
  if (tenantIds === null || tenantIds.includes(tenantId)) {
    return;
  }

  reply.code(403);
  throw new Error("只能管理自己所属的校园墙");
}

/** 只有系统运维可以执行的操作（开墙申请审核、彻底删除校园墙）。 */
async function requireSystemOperatorContext(request: FastifyRequest, reply: FastifyReply) {
  const context = await requirePlatformAdmin(request, reply);
  if (!isSystemOperator(context)) {
    reply.code(403);
    throw new Error("该操作只有系统运维可以执行");
  }
  return context;
}

/**
 * 收集某个校园墙用到对象存储的附件 key。
 * 数据来自稿件附件、竞选封面/选项图，以及墙面元数据（logo 等）里出现的 tenants/ 前缀字符串。
 */
async function collectTenantAttachmentKeys(tenantId: string): Promise<string[]> {
  const keys = new Set<string>();
  const pushKey = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("tenants/")) {
        keys.add(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        pushKey(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.key === "string" && record.key.trim().startsWith("tenants/")) {
        keys.add(record.key.trim());
      }
      for (const item of Object.values(record)) {
        if (typeof item === "object" && item !== null) {
          pushKey(item);
        }
      }
    }
  };

  const [posts, campaigns, metadata] = await Promise.all([
    prisma.post.findMany({ where: { tenantId }, select: { attachments: true } }),
    prisma.campaign.findMany({
      where: { tenantId },
      select: { coverAttachment: true, options: { select: { imageAttachment: true } } },
    }),
    prisma.tenantMetadata.findMany({ where: { tenantId }, select: { value: true } }),
  ]);
  for (const post of posts) {
    pushKey(post.attachments);
  }
  for (const campaign of campaigns) {
    pushKey(campaign.coverAttachment);
    for (const option of campaign.options) {
      pushKey(option.imageAttachment);
    }
  }
  for (const entry of metadata) {
    pushKey(entry.value);
  }
  return [...keys];
}

async function getManagementHost() {
  const setting = await prisma.systemSetting.findUnique({
    where: {
      key: "management_host",
    },
  });
  return typeof setting?.value === "string" ? normalizeTenantHost(setting.value) : null;
}

async function assertHostNotReserved(host: string | null, reply: FastifyReply, options: { tenantId?: string; setting?: "management_host" } = {}) {
  if (!host) {
    return;
  }

  if (options.setting !== "management_host") {
    const managementHost = await getManagementHost();
    if (managementHost === host) {
      return reply.code(409).send({ message: "这个 host 已经被设置为管理端 host" });
    }
  }

  const existingTenant = await prisma.tenant.findFirst({
    where: {
      host,
      ...(options.tenantId ? { id: { not: options.tenantId } } : {}),
    },
    select: { id: true },
  });
  if (existingTenant) {
    return reply.code(409).send({ message: "这个 host 已经绑定到其他校园墙" });
  }
}

async function listSystemTenants(context: PlatformContext, oneBot?: OneBotRuntime) {
  const tenantIds = manageableTenantIds(context);
  const tenants = await prisma.tenant.findMany({
    where: tenantIds === null ? {} : { id: { in: tenantIds } },
    include: {
      botAccounts: {
        include: {
          publishTargets: {
            orderBy: {
              displayName: "asc",
            },
          },
          sessions: {
            where: { type: "qzone" },
            orderBy: { refreshedAt: "desc" },
            take: 1,
            select: { healthStatus: true },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      },
      _count: {
        select: {
          botAccounts: true,
          posts: true,
          memberships: true,
        },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return tenants.map((tenant) => toSystemTenant(tenant, oneBot));
}

function tenantDomainSuffixForResponse(config: CampuxConfig) {
  if (!tenantDomainAutomationEnabled(config)) {
    return null;
  }
  try {
    return normalizeDomainSuffix(config.tenantDomains.suffix);
  } catch {
    return null;
  }
}

export function registerSystemRoutes(app: FastifyInstance, queue: RuntimeQueue, config: CampuxConfig, oneBot?: OneBotRuntime) {
  app.get("/api/system/settings", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    if (!isSystemOperator(context)) {
      return reply.code(403).send({ message: "只有系统运维可以查看全局设置" });
    }

    return {
      managementHost: await getManagementHost(),
    };
  });

  app.patch("/api/system/settings", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    if (!isSystemOperator(context)) {
      return reply.code(403).send({ message: "只有系统运维可以修改全局设置" });
    }
    const body = systemSettingsPatchSchema.parse(request.body);
    const normalizedManagementHost = body.managementHost === undefined ? undefined : normalizeTenantHost(body.managementHost);
    if (normalizedManagementHost !== undefined) {
      const conflict = await assertHostNotReserved(normalizedManagementHost, reply, { setting: "management_host" });
      if (conflict) return conflict;
    }

    if (body.managementHost !== undefined) {
      if (normalizedManagementHost) {
        await prisma.systemSetting.upsert({
          where: { key: "management_host" },
          update: { value: normalizedManagementHost },
          create: { key: "management_host", value: normalizedManagementHost },
        });
      } else {
        await prisma.systemSetting.deleteMany({
          where: { key: "management_host" },
        });
      }

      await writeAuditLog({
        tenantId: null,
        actorId: context.user.id,
        action: "system.settings.update",
        targetType: "system_setting",
        targetId: "management_host",
        detail: {
          managementHost: normalizedManagementHost,
        },
      });
    }

    return {
      managementHost: await getManagementHost(),
    };
  });

  // ── 开墙申请（只有系统运维可查看与审核）───────────────
  app.get("/api/system/tenant-applications", async (request, reply) => {
    await requireSystemOperatorContext(request, reply);
    const query = tenantApplicationQuerySchema.parse(request.query);
    const where: Prisma.TenantApplicationWhereInput = query.status === "all" ? {} : { status: query.status };
    const [total, pendingCount, applications] = await Promise.all([
      prisma.tenantApplication.count({ where }),
      prisma.tenantApplication.count({ where: { status: "pending" } }),
      prisma.tenantApplication.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          user: { select: { id: true, qqUin: true, email: true, displayName: true, createdAt: true } },
          reviewedBy: { select: { displayName: true, email: true } },
        },
      }),
    ]);

    const userIds = applications.map((item) => item.userId);
    const administered = userIds.length > 0
      ? await prisma.tenantMembership.findMany({
          where: { userId: { in: userIds }, role: "admin" },
          select: { userId: true, tenant: { select: { id: true, name: true, slug: true, status: true } } },
        })
      : [];
    const tenantsByUser = new Map<string, Array<{ id: string; name: string; slug: string; status: string }>>();
    for (const membership of administered) {
      const list = tenantsByUser.get(membership.userId) ?? [];
      list.push(membership.tenant);
      tenantsByUser.set(membership.userId, list);
    }

    return {
      pendingCount,
      items: applications.map((application) => ({
        ...toTenantApplicationSummary(application),
        applicant: {
          id: application.user.id,
          displayName: application.user.displayName,
          email: application.user.email,
          qqUin: application.user.qqUin.toString(),
          registeredAt: application.user.createdAt.toISOString(),
        },
        reviewedByName: application.reviewedBy?.displayName ?? application.reviewedBy?.email ?? null,
        tenants: tenantsByUser.get(application.userId) ?? [],
      })),
      pagination: toPagination(query.page, query.limit, total),
    };
  });

  app.post("/api/system/tenant-applications/:id/review", async (request, reply) => {
    const context = await requireSystemOperatorContext(request, reply);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = tenantApplicationReviewSchema.parse(request.body ?? {});
    const result = await reviewTenantApplication({
      applicationId: params.id,
      reviewerId: context.user.id,
      action: body.action,
      note: body.note ?? null,
    });
    if (!result.ok) {
      return reply.code(result.code === "not_found" ? 404 : 409).send({ message: result.message, code: result.code });
    }
    await writeAuditLog({
      tenantId: null,
      actorId: context.user.id,
      action: body.action === "approve" ? "tenant.application.approve" : "tenant.application.reject",
      targetType: "tenant_application",
      targetId: params.id,
      detail: {
        wallName: result.application.wallName,
        applicantUserId: result.application.id,
        note: body.note ?? null,
      },
    });
    return { ok: true, application: result.application };
  });

  // ── 删除前的数据导出 ──────────────────────────────────
  app.get("/api/system/tenants/:tenantId/export", async (request, reply) => {
    await requireSystemOperatorContext(request, reply);
    const params = z.object({ tenantId: z.string().min(1) }).parse(request.params);
    const bundle = await buildTenantExportBundle(params.tenantId);
    if (!bundle) {
      return reply.code(404).send({ message: "校园墙不存在" });
    }
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="tenant-export-${params.tenantId}-${Date.now()}.json"`,
    );
    return bundle;
  });

  // ── 彻底删除校园墙（仅系统运维，不可恢复）─────────────
  app.delete("/api/system/tenants/:tenantId", async (request, reply) => {
    const context = await requireSystemOperatorContext(request, reply);
    const params = z.object({ tenantId: z.string().min(1) }).parse(request.params);
    const body = tenantDeleteSchema.parse(request.body ?? {});
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.tenantId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant) {
      return reply.code(404).send({ message: "校园墙不存在" });
    }
    if (body.confirmName.trim() !== tenant.name) {
      return reply.code(400).send({ code: "name_mismatch", message: "输入的校园墙名称与要删除的墙不一致" });
    }
    if (!body.backupAcknowledged) {
      return reply.code(400).send({ code: "backup_required", message: "请先导出备份，并确认已保存后再删除" });
    }

    const attachmentKeys = await collectTenantAttachmentKeys(tenant.id).catch((error) => {
      request.log.warn({ error, tenantId: tenant.id }, "failed to collect tenant attachment keys");
      return [] as string[];
    });

    if (attachmentKeys.length > 0) {
      await deleteAttachmentObjects(config, attachmentKeys).catch((error) => {
        request.log.warn({ error, tenantId: tenant.id, count: attachmentKeys.length }, "failed to delete tenant attachments");
      });
    }

    // 数据库里所有引用 Tenant 的表都是级联删除；审计日志会把 tenantId 置空以保留历史。
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await writeAuditLog({
      tenantId: null,
      actorId: context.user.id,
      action: "tenant.delete",
      targetType: "tenant",
      targetId: tenant.id,
      detail: {
        name: tenant.name,
        slug: tenant.slug,
        previousStatus: tenant.status,
        deletedAttachments: attachmentKeys.length,
      },
    });

    return {
      ok: true,
      deletedTenantId: tenant.id,
      deletedAttachments: attachmentKeys.length,
    };
  });

  app.get("/api/system/tenants", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);

    return {
      tenants: await listSystemTenants(context, oneBot),
      tenantDomainSuffix: tenantDomainSuffixForResponse(config),
    };
  });

  app.post("/api/system/tenants", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    // 开墙需要系统运维审核通过：系统运维本人不受限制，其他人必须有已通过的申请且尚无墙。
    const creationPermission = await resolveTenantCreationPermission(context.user);
    if (!creationPermission.allowed) {
      return reply.code(403).send({
        code: `tenant_create_${creationPermission.code}`,
        message: creationPermission.message,
      });
    }
    const body = tenantCreateSchema.parse(request.body);
    const manualHost = body.host === undefined ? null : normalizeTenantHost(body.host);
    let normalizedHost = manualHost;
    if (!normalizedHost && tenantDomainAutomationEnabled(config)) {
      try {
        normalizedHost = buildTenantDomainHost(body.slug, config.tenantDomains.suffix);
      } catch (caught) {
        if (caught instanceof TenantDomainProvisioningError) {
          return reply.code(500).send({ message: caught.message });
        }
        throw caught;
      }
    }
    if (normalizedHost) {
      const conflict = await assertHostNotReserved(normalizedHost, reply);
      if (conflict) return conflict;
    }
    const existingSlug = await prisma.tenant.findUnique({
      where: {
        slug: body.slug,
      },
      select: {
        id: true,
      },
    });
    if (existingSlug) {
      return reply.code(409).send({ message: "这个网址标识已经被其他校园墙使用" });
    }
    if (body.botQqUin) {
      const existingBot = await prisma.botAccount.findFirst({
        where: {
          platform: "onebot",
          qqUin: BigInt(body.botQqUin),
        },
        select: {
          id: true,
        },
      });
      if (existingBot) {
        return reply.code(409).send({ message: "这个机器人 QQ 已经绑定到其他校园墙" });
      }
    }

    let cloudflareDnsRecordId: string | null = null;
    if (!manualHost && normalizedHost && tenantDomainAutomationEnabled(config)) {
      try {
        const targetHost = resolveDnsTargetHost(config.tenantDomains.targetHost ?? await getManagementHost() ?? config.webOrigin);
        if (!targetHost) {
          return reply.code(500).send({ message: "自动域名已启用，但没有可用的 DNS CNAME 目标" });
        }
        const record = await provisionTenantDomain({
          config,
          host: normalizedHost,
          targetHost,
        });
        cloudflareDnsRecordId = record?.id ?? null;
      } catch (caught) {
        request.log.error({ err: caught, host: normalizedHost }, "failed to provision tenant domain");
        if (caught instanceof TenantDomainProvisioningError) {
          return reply.code(502).send({ message: caught.message });
        }
        throw caught;
      }
    }

    const tenant = await prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: {
          name: body.name,
          slug: body.slug,
          host: normalizedHost,
          themeColor: body.themeColor,
          status: "active",
          metadata: {
            create: [
              { key: "brand", value: body.name },
              { key: "banner", value: body.banner },
              { key: "post_rules", value: defaultPostRules },
              { key: "pending_post_limit", value: 1 },
              { key: "services", value: defaultServices },
              { key: "publish_mode", value: "single" },
            ],
          },
        },
      });

      const adminUserIds = isSystemOperator(context)
        ? await tx.user
            .findMany({
              where: {
                systemRole: "system_operator",
              },
              select: {
                id: true,
              },
            })
            .then((users) => users.map((user) => user.id))
        : [context.user.id];

      const uniqueAdminUserIds = buildTenantAdminUserIds(adminUserIds, context.user.id);
      await createManyDedup(
        tx.tenantMembership,
        uniqueAdminUserIds.map((userId) => ({
          tenantId: created.id,
          userId,
          role: "admin" as const,
        })),
        (row) => `${row.tenantId}:${row.userId}`,
      );

      if (body.botQqUin) {
        const bot = await tx.botAccount.create({
          data: {
            tenantId: created.id,
            qqUin: BigInt(body.botQqUin),
            displayName: `${body.name} 1 号墙`,
            enabled: true,
          },
        });
        await tx.publishTarget.create({
          data: {
            tenantId: created.id,
            botAccountId: bot.id,
            displayName: "主墙号",
            enabled: true,
            required: true,
          },
        });
      }

      return created;
    });

    await writeAuditLog({
      tenantId: tenant.id,
      actorId: context.user.id,
      action: "tenant.create",
      targetType: "tenant",
      targetId: tenant.id,
      detail: {
        slug: tenant.slug,
        host: tenant.host,
        cloudflareDnsRecordId,
      },
    });

    // 触发插件事件：租户创建
    const events = app.pluginEvents as EventBus | undefined;
    events?.emit({
      type: "tenant:created",
      tenantId: tenant.id,
    });

    return {
      tenants: await listSystemTenants(context, oneBot),
      tenantDomainSuffix: tenantDomainSuffixForResponse(config),
    };
  });

  app.patch("/api/system/tenants/:tenantId", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const params = z.object({ tenantId: z.string().min(1) }).parse(request.params);
    assertCanManageTenant(context, params.tenantId, reply);
    const body = tenantPatchSchema.parse(request.body);
    const normalizedHost = body.host === undefined ? undefined : normalizeTenantHost(body.host);
    if (normalizedHost) {
      const conflict = await assertHostNotReserved(normalizedHost, reply, { tenantId: params.tenantId });
      if (conflict) return conflict;
    }

    if (body.status === "active") {
      try {
        await retryTransactionSerializationFailures(
          () => prisma.$transaction(async (tx) => {
            const adminCount = await tx.tenantMembership.count({
              where: { tenantId: params.tenantId, role: "admin" },
            });
            assertTenantActivationAllowed(adminCount);
          }, { isolationLevel: TransactionIsolationLevel.Serializable }),
          isTransactionSerializationFailure,
        );
      } catch (error) {
        const response = tenantAdminInvariantErrorResponse(error);
        if (response) {
          return reply.code(response.statusCode).send({ code: response.code, message: response.message });
        }
        throw error;
      }
    }

    // When the host is changing and either the old or new host is managed by
    // the auto-domain automation, sync Cloudflare before the authoritative DB
    // transaction. If that transaction fails, the DNS move is compensated in
    // reverse below so the two systems converge on the previous host.
    const hostChanging = body.host !== undefined;
    let cloudflareDnsRecordId: string | null = null;
    let dnsChange: {
      previousHost: string | null;
      nextHost: string | null;
      compensate: () => Promise<void>;
    } | null = null;
    if (hostChanging && tenantDomainAutomationEnabled(config)) {
      const current = await prisma.tenant.findUnique({
        where: { id: params.tenantId },
        select: { host: true },
      });
      const previousHost = current?.host ?? null;
      const touchesAutomation =
        hostIsUnderTenantSuffix(config, previousHost) || hostIsUnderTenantSuffix(config, normalizedHost);
      if (touchesAutomation && previousHost !== (normalizedHost ?? null)) {
        try {
          const targetHost = resolveDnsTargetHost(
            config.tenantDomains.targetHost ?? (await getManagementHost()) ?? config.webOrigin,
          );
          if (!targetHost) {
            return reply.code(500).send({ message: "自动域名已启用，但没有可用的 DNS CNAME 目标" });
          }
          const nextHost = normalizedHost ?? null;
          const change = await reprovisionTenantDomainWithCompensation({
            config,
            previousHost,
            nextHost,
            targetHost,
          });
          cloudflareDnsRecordId = change.recordId;
          dnsChange = { previousHost, nextHost, compensate: change.compensate };
        } catch (caught) {
          request.log.error({ err: caught, tenantId: params.tenantId, host: normalizedHost }, "failed to reprovision tenant domain");
          if (caught instanceof TenantDomainProvisioningError) {
            return reply.code(502).send({ message: caught.message });
          }
          throw caught;
        }
      }
    }

    const updateData: {
      status?: z.infer<typeof tenantStatusSchema>;
      host?: string | null;
      archiveWarningAt?: Date | null;
    } = {};
    if (body.status !== undefined) updateData.status = body.status;
    if (body.host !== undefined) updateData.host = normalizedHost ?? null;
    // Restoring a wall to active clears any pending auto-archive warning so the
    // scheduler does not immediately re-archive it.
    if (body.status === "active") updateData.archiveWarningAt = null;

    const auditInput = {
      tenantId: params.tenantId,
      actorId: context.user.id,
      action: "tenant.lifecycle.update",
      targetType: "tenant",
      targetId: params.tenantId,
      detail: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.host !== undefined ? { host: normalizedHost } : {}),
        ...(cloudflareDnsRecordId ? { cloudflareDnsRecordId } : {}),
      },
    };
    let runtimeTransitionAttempted = false;
    if (body.status !== undefined && body.status !== "active") {
      // Fence local OneBot work before waiting on an in-flight durable lease.
      // If persistence fails, the catch path below reconciles the fence to the
      // authoritative persisted status.
      runtimeTransitionAttempted = true;
      oneBot?.disconnectTenant(params.tenantId);
    }
    const persistTenant = () => retryTransactionSerializationFailures(
      () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const lockedTenant = await lockTenantRuntime(tx, params.tenantId);
        if (!lockedTenant) {
          throw new Error("tenant not found");
        }
        const currentStatus = lockedTenant.status;
        const statusChanged = body.status !== undefined && currentStatus !== body.status;
        if (statusChanged) {
          runtimeTransitionAttempted = true;
          if (body.status === "active") {
            oneBot?.activateTenant(params.tenantId);
          }
        }
        const tenant = body.status === "active"
          ? await updateTenantAfterAdminCheck({
              countAdmins: () => tx.tenantMembership.count({
                where: { tenantId: params.tenantId, role: "admin" },
              }),
              updateTenant: () => tx.tenant.update({
                where: { id: params.tenantId },
                data: updateData,
              }),
            })
          : await tx.tenant.update({
              where: { id: params.tenantId },
              data: updateData,
            });
        await writeAuditLog(auditInput, tx);
        return tenant;
      }, { isolationLevel: TransactionIsolationLevel.Serializable }),
      isTransactionSerializationFailure,
    );

    const appliedDnsChange = dnsChange;
    try {
      await (appliedDnsChange
        ? persistAfterTenantDomainReprovision({
          persist: persistTenant,
          compensate: appliedDnsChange.compensate,
        })
        : persistTenant());
    } catch (error) {
      if (runtimeTransitionAttempted) {
        const persisted = await prisma.tenant.findUnique({
          where: { id: params.tenantId },
          select: { status: true },
        });
        if (persisted?.status === "active") {
          oneBot?.activateTenant(params.tenantId);
        } else if (persisted) {
          oneBot?.disconnectTenant(params.tenantId);
        }
      }
      if (error instanceof TenantDomainCompensationError) {
        request.log.error({
          err: error.compensationError,
          persistenceError: error.persistenceError,
          tenantId: params.tenantId,
          previousHost: appliedDnsChange?.previousHost,
          nextHost: appliedDnsChange?.nextHost,
        }, "tenant update and tenant domain compensation both failed");
        throw error;
      }
      if (appliedDnsChange) {
        request.log.warn({
          err: error,
          tenantId: params.tenantId,
          previousHost: appliedDnsChange.previousHost,
          nextHost: appliedDnsChange.nextHost,
        }, "tenant update failed; compensated tenant domain change");
      }
      const response = tenantAdminInvariantErrorResponse(error);
      if (response) {
        return reply.code(response.statusCode).send({ code: response.code, message: response.message });
      }
      throw error;
    }

    // 触发插件事件：租户状态变更
    if (body.status !== undefined) {
      const events = app.pluginEvents as EventBus | undefined;
      const eventMap: Record<string, PluginEvent["type"]> = {
        active: "tenant:activated",
        paused: "tenant:paused",
        archived: "tenant:archived",
      };
      const eventType = eventMap[body.status];
      if (eventType) {
        events?.emit({
          type: eventType,
          tenantId: params.tenantId,
        });
      }
    }

    return {
      tenants: await listSystemTenants(context, oneBot),
      tenantDomainSuffix: tenantDomainSuffixForResponse(config),
    };
  });

  app.get("/api/system/users", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const query = systemUsersQuerySchema.parse(request.query);
    const roleFilters = parseSystemUserRoleFilters(query.roles);
    const tenantRoleFilters = roleFilters.filter((role): role is z.infer<typeof tenantRoleSchema> => tenantRoleSchema.safeParse(role).success);
    const includeSystemOperator = isSystemOperator(context) && roleFilters.includes("system_operator");
    const includeOperationsAdmin = isSystemOperator(context) && roleFilters.includes("operations_admin");
    const keyword = query.q?.trim();
    const filters: Prisma.UserWhereInput[] = [];
    const tenantIds = manageableTenantIds(context);
    if (tenantIds !== null && tenantIds.length === 0) {
      return {
        total: 0,
        pagination: toPagination(query.page, query.limit, 0),
        users: [],
      };
    }
    if (query.tenantId && tenantIds !== null && !tenantIds.includes(query.tenantId)) {
      return reply.code(403).send({ message: "只能查看自己所属校园墙的用户" });
    }
    const scopedTenantIds = query.tenantId ? [query.tenantId] : tenantIds;

    if (scopedTenantIds !== null && roleFilters.length === 0) {
      filters.push({
        memberships: {
          some: {
            tenantId: { in: scopedTenantIds },
          },
        },
      });
    }

    if (roleFilters.length > 0) {
      const roleFilterTenantIds = query.tenantId ? [query.tenantId] : scopedTenantIds;
      const roleConditions: Prisma.UserWhereInput[] = [
        ...(includeSystemOperator ? [{ systemRole: "system_operator" as const }] : []),
        ...(includeOperationsAdmin ? [{ systemRole: "operations_admin" as const }] : []),
      ];

      if (tenantRoleFilters.length > 0) {
        roleConditions.push({
          memberships: {
            some: {
              ...(roleFilterTenantIds === null ? {} : { tenantId: { in: roleFilterTenantIds } }),
              role: { in: tenantRoleFilters },
            },
          },
        });
      }

      if (roleConditions.length > 0) {
        filters.push({ OR: roleConditions });
      } else {
        filters.push({ id: "__no_visible_role_match__" });
      }
    }
    if (keyword) {
      const searchWhere = await buildUserContainsSearch(keyword);
      if (searchWhere) filters.push(searchWhere);
    }
    const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: {
          memberships: {
            include: {
              tenant: true,
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      total,
      pagination: toPagination(query.page, query.limit, total),
      users: users.map((user) => ({
        id: user.id,
        qqUin: user.qqUin.toString(),
        email: user.email,
        displayName: user.displayName,
        isTestAccount: user.isTestAccount,
        createdAt: user.createdAt.toISOString(),
        systemRole: isSystemOperator(context) ? user.systemRole : null,
        memberships: user.memberships
          .filter((membership) => tenantIds === null || tenantIds.includes(membership.tenantId))
          .map((membership) => ({
            id: membership.id,
            role: membership.role,
            tenant: {
              id: membership.tenant.id,
              name: membership.tenant.name,
              slug: membership.tenant.slug,
              status: membership.tenant.status,
            },
          })),
      })),
    };
  });

  app.post("/api/system/users/:userId/memberships", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const body = userMembershipCreateSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id: params.userId } });
    if (!user) {
      return reply.code(404).send({ message: "用户不存在" });
    }

    if (body.role === "system_operator" || body.role === "operations_admin") {
      if (!isSystemOperator(context)) {
        return reply.code(403).send({ message: "只有系统运维可以授予平台级身份" });
      }
      if (body.role === "operations_admin" && user.systemRole === "system_operator") {
        return {
          ok: true,
          systemRole: user.systemRole,
          retainedHigherRole: true,
        };
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { systemRole: body.role },
      });

      await writeAuditLog({
        tenantId: null,
        actorId: context.user.id,
        action: "system.user.role.assign",
        targetType: "user",
        targetId: user.id,
        detail: {
          qqUin: user.qqUin.toString(),
          systemRole: body.role,
        },
      });

      return {
        ok: true,
        systemRole: body.role,
      };
    }

    if (!body.tenantId) {
      return reply.code(400).send({ message: "添加租户身份时必须选择校园墙" });
    }
    const tenantRole = body.role;
    assertCanManageTenant(context, body.tenantId, reply);

    const tenant = await prisma.tenant.findUnique({ where: { id: body.tenantId } });
    if (!tenant) {
      return reply.code(404).send({ message: "租户不存在" });
    }

    let membership;
    try {
      membership = await retryTransactionSerializationFailures(
        () => prisma.$transaction(async (tx) => {
          const existingMembership = await tx.tenantMembership.findUnique({
            where: {
              tenantId_userId: {
                tenantId: tenant.id,
                userId: user.id,
              },
            },
          });

          if (existingMembership?.role === "admin" && tenantRole !== "admin") {
            const adminCount = await tx.tenantMembership.count({
              where: { tenantId: tenant.id, role: "admin" },
            });
            assertTenantMembershipRoleChangeAllowed({
              currentRole: existingMembership.role,
              nextRole: tenantRole,
              adminCount,
            });
          }

          return tx.tenantMembership.upsert({
            where: {
              tenantId_userId: {
                tenantId: tenant.id,
                userId: user.id,
              },
            },
            update: {
              role: tenantRole,
            },
            create: {
              tenantId: tenant.id,
              userId: user.id,
              role: tenantRole,
            },
          });
        }, { isolationLevel: TransactionIsolationLevel.Serializable }),
        isTransactionSerializationFailure,
      );
    } catch (error) {
      const response = tenantAdminInvariantErrorResponse(error);
      if (response) {
        return reply.code(response.statusCode).send({ code: response.code, message: response.message });
      }
      throw error;
    }

    await writeAuditLog({
      tenantId: tenant.id,
      actorId: context.user.id,
      action: "system.member.assign",
      targetType: "membership",
      targetId: membership.id,
      detail: {
        qqUin: user.qqUin.toString(),
        tenantId: tenant.id,
        tenantName: tenant.name,
        role: tenantRole,
      },
    });

    return {
      ok: true,
      membership: {
        id: membership.id,
        role: membership.role,
      },
    };
  });

  app.delete("/api/system/users/:userId/memberships/:membershipId", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const params = z.object({ userId: z.string().min(1), membershipId: z.string().min(1) }).parse(request.params);
    let membership;
    try {
      membership = await retryTransactionSerializationFailures(
        () => prisma.$transaction(async (tx) => {
          const existingMembership = await tx.tenantMembership.findFirst({
            where: {
              id: params.membershipId,
              userId: params.userId,
            },
            include: {
              tenant: true,
              user: true,
            },
          });
          if (!existingMembership) {
            return null;
          }
          assertCanManageTenant(context, existingMembership.tenantId, reply);

          if (existingMembership.role === "admin") {
            const adminCount = await tx.tenantMembership.count({
              where: { tenantId: existingMembership.tenantId, role: "admin" },
            });
            assertTenantMembershipRemovalAllowed({
              role: existingMembership.role,
              adminCount,
            });
          }

          await tx.tenantMembership.delete({
            where: { id: existingMembership.id },
          });
          return existingMembership;
        }, { isolationLevel: TransactionIsolationLevel.Serializable }),
        isTransactionSerializationFailure,
      );
    } catch (error) {
      const response = tenantAdminInvariantErrorResponse(error);
      if (response) {
        return reply.code(response.statusCode).send({ code: response.code, message: response.message });
      }
      throw error;
    }

    if (!membership) {
      return reply.code(404).send({ message: "租户身份不存在" });
    }

    await writeAuditLog({
      tenantId: membership.tenantId,
      actorId: context.user.id,
      action: "system.member.revoke",
      targetType: "membership",
      targetId: membership.id,
      detail: {
        qqUin: membership.user.qqUin.toString(),
        tenantId: membership.tenantId,
        tenantName: membership.tenant.name,
        role: membership.role,
      },
    });

    return {
      ok: true,
    };
  });

  app.get("/api/system/bots", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const tenantIds = manageableTenantIds(context);
    const bots = await prisma.botAccount.findMany({
      where: tenantIds === null ? {} : { tenantId: { in: tenantIds } },
      include: {
        tenant: true,
        publishTargets: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
    });

    return {
      bots: bots.map((bot) => ({
        id: bot.id,
        qqUin: bot.qqUin.toString(),
        displayName: bot.displayName,
        enabled: bot.enabled,
        reviewGroupId: bot.reviewGroupId,
        lastSeenAt: bot.lastSeenAt?.toISOString() ?? null,
        tenant: {
          id: bot.tenant.id,
          name: bot.tenant.name,
          slug: bot.tenant.slug,
          status: bot.tenant.status,
        },
        publishTargets: bot.publishTargets.map((target) => ({
          id: target.id,
          displayName: target.displayName,
          enabled: target.enabled,
          required: target.required,
        })),
      })),
    };
  });

  app.get("/api/system/queue", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const tenantIds = manageableTenantIds(context);
    const attemptWhere: Prisma.PublishAttemptWhereInput = tenantIds === null ? {} : { tenantId: { in: tenantIds } };
    const [queued, running, failed, succeeded] = await Promise.all([
      prisma.publishAttempt.count({ where: { ...attemptWhere, status: "queued" } }),
      prisma.publishAttempt.count({ where: { ...attemptWhere, status: "running" } }),
      prisma.publishAttempt.count({ where: { ...attemptWhere, status: "failed" } }),
      prisma.publishAttempt.count({ where: { ...attemptWhere, status: "succeeded" } }),
    ]);
    const runtime = queue.snapshot();

    return {
      runtime: tenantIds === null ? runtime : { ...runtime, queued, processing: running, failed, lastError: null },
      publishAttempts: {
        queued,
        running,
        failed,
        succeeded,
      },
    };
  });

  app.get("/api/system/audit-logs", async (request, reply) => {
    const context = await requirePlatformAdmin(request, reply);
    const query = paginationQuerySchema.parse(request.query);
    const tenantIds = manageableTenantIds(context);
    const where: Prisma.AuditLogWhereInput = tenantIds === null ? {} : { tenantId: { in: tenantIds } };
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: {
          tenant: true,
          actor: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      pagination: toPagination(query.page, query.limit, total),
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        detail: log.detail,
        createdAt: log.createdAt.toISOString(),
        tenant: log.tenant
          ? {
              id: log.tenant.id,
              name: log.tenant.name,
              slug: log.tenant.slug,
            }
          : null,
        actor: log.actor
          ? {
              id: log.actor.id,
              qqUin: log.actor.qqUin.toString(),
              displayName: log.actor.displayName,
            }
          : null,
      })),
    };
  });
}

function toPagination(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    pageCount: Math.max(1, Math.ceil(total / limit)),
  };
}

function parseSystemUserRoleFilters(value: string | undefined) {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
    .map((item) => systemUserRoleFilterSchema.safeParse(item))
    .filter((result) => result.success)
    .map((result) => result.data);
}
