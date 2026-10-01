import type { FastifyInstance } from "fastify";
import type { CampuxConfig } from "@campux/config";
import { hashPassword, Prisma, verifyPassword } from "@campux/db";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { clearSessionCookie, createSession, findActiveBan, getCookie, getSessionContext, hashToken, requireSession, sessionCookieName, setSessionCookie } from "../lib/auth";
import { normalizeEmail } from "../lib/email";
import { checkRateLimit, clientIpFromRequest } from "../lib/rate-limit";
import { verifyTurnstileToken } from "../lib/turnstile";
import { prisma } from "../lib/prisma";
import { toMembership, toPublicUser, toTenantSummary } from "../lib/serializers";
import { resolveEffectiveTenantMembership } from "../lib/tenant-access";
import { findManagementHostByRequest, findTenantByRequestHost } from "../lib/tenant-host";
import { getDeployMode, resolveSingleModeTenantId } from "../lib/deploy-mode";
import { getLatestTenantApplication, resolveTenantCreationPermission, submitTenantApplication, toTenantApplicationSummary } from "../lib/tenant-application";

const loginSchema = z.object({
  account: z.string().trim().min(1).optional(),
  qqUin: z.string().trim().min(1).optional(),
  password: z.string().min(1),
});

const emailSchema = z.string().trim().email("邮箱格式不正确").max(255);

const updateMeSettingsSchema = z.object({
  autoFollowOwnPosts: z.boolean().optional(),
});

/** 申请开墙的注册限流：同一来源每小时最多 5 次提交。 */
const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1_000;

const registerSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1, "账户名称不能为空").max(80, "账户名称最多 80 个字符"),
  password: z.string().min(6).max(128),
  // 开墙申请信息：注册即提交申请，需系统运维审核通过后才能创建校园墙。
  wallName: z.string().trim().min(2, "想开的墙名至少 2 个字符").max(40, "墙名最多 40 个字符"),
  school: z.string().trim().max(60).optional(),
  contact: z.string().trim().min(2, "请填写联系方式（QQ / 微信 / 手机号）").max(80),
  reason: z.string().trim().max(300).optional(),
  /** Cloudflare Turnstile 人机验证 token（未配置 Turnstile 时可不传）。 */
  turnstileToken: z.string().trim().max(4096).optional(),
});

/** 重新提交申请时用的字段（与注册时的墙名/学校/联系方式一致）。 */
const registerApplicationSchema = z.object({
  wallName: z.string().trim().min(2, "想开的墙名至少 2 个字符").max(40, "墙名最多 40 个字符"),
  school: z.string().trim().max(60).optional(),
  contact: z.string().trim().min(2, "请填写联系方式（QQ / 微信 / 手机号）").max(80),
  reason: z.string().trim().max(300).optional(),
});

const selectTenantSchema = z.object({
  tenantId: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
});

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1, "账户名称不能为空").max(80, "账户名称最多 80 个字符"),
});

const requiredPasswordChangeSchema = z.object({
  newPassword: z.string().min(6).max(128),
});

export function registerAuthRoutes(app: FastifyInstance, config: CampuxConfig) {
  app.get("/api/auth/context", async (request) => {
    const [managementHost, hostTenant, deployMode] = await Promise.all([
      findManagementHostByRequest(request),
      findTenantByRequestHost(request),
      getDeployMode(),
    ]);
    return {
      managementHost: Boolean(managementHost),
      currentTenant: hostTenant ? toTenantSummary(hostTenant) : null,
      deployMode,
      // 「申请开墙」表单的人机验证 site key（未配置 Turnstile 时为空字符串，前端不渲染）。
      turnstileSiteKey: config.turnstile.enabled ? config.turnstile.siteKey : "",
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const account = (body.account ?? body.qqUin ?? "").trim();
    const email = account.includes("@") ? normalizeEmail(account) : null;
    const qqUin = /^\d+$/.test(account) ? BigInt(account) : null;
    if (!email && qqUin === null) {
      return reply.code(400).send({ message: "请输入 QQ 号或邮箱" });
    }
    const user = await prisma.user.findUnique({
      where: email ? { email } : { qqUin: qqUin! },
      include: {
        memberships: {
          include: {
            tenant: {
              include: {
                metadata: {
                  where: {
                    key: "logo_url",
                  },
                },
                aiSettings: {
                  select: {
                    enabled: true,
                  },
                },
                _count: {
                  select: {
                    botAccounts: true,
                    posts: {
                      where: {
                        status: "pending_approval",
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({
        message: "账号或密码错误",
      });
    }

    if (user.isTestAccount && config.nodeEnv !== "development") {
      return reply.code(403).send({
        message: "测试账号只能在开发环境登录",
      });
    }

    // 平台级停用：数据保留但禁止登录（系统运维可在运维面板恢复）。
    if (user.disabledAt) {
      return reply.code(403).send({
        message: user.disabledReason
          ? `该账号已被停用：${user.disabledReason}`
          : "该账号已被系统运维停用，如有疑问请联系系统运维。",
      });
    }

    const hostTenant = await findTenantByRequestHost(request);
    if (hostTenant) {
      const hostMembership = user.memberships.find((membership) => membership.tenantId === hostTenant.id);
      const effectiveMembership = resolveEffectiveTenantMembership({
        userId: user.id,
        systemRole: user.systemRole,
        tenantId: hostTenant.id,
        memberships: user.memberships,
      });
      if (!effectiveMembership) {
        return reply.code(403).send({
          message: "该账号没有访问当前校园墙的权限",
        });
      }

      const token = await createSession(user.id, hostTenant.id);
      setSessionCookie(reply, token);
      const visibleMemberships = hostMembership === undefined ? [] : [toMembership(hostMembership)];

      return {
        authenticated: true,
        user: toPublicUser(user),
        memberships: visibleMemberships,
        currentTenant: toTenantSummary(hostTenant),
        currentMembership: { id: effectiveMembership.id, role: effectiveMembership.role },
        activeBan: hostMembership ? toActiveBan(await findActiveBan(hostTenant.id, user.id)) : null,
        needsTenantSelection: false,
        hostLocked: true,
      };
    }

    const systemAccessibleTenants = await listSystemAccessibleTenants(user.systemRole);
    // Single-mode: bind directly to the sole wall so the operator never sees a
    // wall picker (mirrors getSessionContext's auto-selection).
    const singleModeTenantId = await resolveSingleModeTenantId();
    const singleModeMembership = singleModeTenantId
      ? resolveEffectiveTenantMembership({
          userId: user.id,
          systemRole: user.systemRole,
          tenantId: singleModeTenantId,
          memberships: user.memberships,
        })
      : null;
    const visibleMemberships = user.memberships.filter((membership) => membership.tenant.status !== "archived");
    const onlyMembership = singleModeTenantId
      ? user.memberships.find((membership) => membership.tenantId === singleModeTenantId)
        ?? (singleModeMembership ? user.memberships[0] : undefined)
      : user.systemRole === "system_operator" ? undefined : visibleMemberships.length === 1 ? visibleMemberships[0] : undefined;
    const selectedTenantId = singleModeTenantId && singleModeMembership ? singleModeTenantId : onlyMembership?.tenantId ?? null;
    const token = await createSession(user.id, selectedTenantId);
    setSessionCookie(reply, token);

    if (singleModeTenantId && singleModeMembership) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: singleModeTenantId },
        include: {
          metadata: { where: { key: "logo_url" } },
          aiSettings: { select: { enabled: true } },
          _count: { select: { botAccounts: true, posts: { where: { status: "pending_approval" } } } },
        },
      });
      const ban = user.memberships.some((m) => m.tenantId === singleModeTenantId) ? await findActiveBan(singleModeTenantId, user.id) : null;
      return {
        authenticated: true,
        user: toPublicUser(user),
        memberships: user.memberships.map(toMembership),
        systemAccessibleTenants,
        currentTenant: tenant ? toTenantSummary(tenant) : null,
        currentMembership: { id: singleModeMembership.id, role: singleModeMembership.role },
        activeBan: toActiveBan(ban),
        needsTenantSelection: false,
        hostLocked: false,
      };
    }

    return {
      authenticated: true,
      user: toPublicUser(user),
      memberships: user.memberships.map(toMembership),
      systemAccessibleTenants,
      currentTenant: onlyMembership ? toTenantSummary(onlyMembership.tenant) : null,
      currentMembership: onlyMembership ? { id: onlyMembership.id, role: onlyMembership.role } : null,
      activeBan: onlyMembership ? toActiveBan(await findActiveBan(onlyMembership.tenantId, user.id)) : null,
      needsTenantSelection: !selectedTenantId && (visibleMemberships.length > 1 || systemAccessibleTenants.length > 0),
      hostLocked: false,
    };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const managementHost = await findManagementHostByRequest(request);
    if (!managementHost) {
      return reply.code(404).send({ message: "当前入口不开放注册" });
    }

    // 用 safeParse 而不是 parse：字段不合法时返回 400 + 友好文案，
    // 否则 Fastify 会把 ZodError 当成 500（前端只会看到"请求失败：500"）。
    const parsedBody = registerSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        message: parsedBody.error.issues[0]?.message ?? "注册信息不完整，请检查后重试",
      });
    }
    const body = parsedBody.data;
    const email = normalizeEmail(body.email);
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      return reply.code(409).send({ message: "这个邮箱已经注册，请直接登录" });
    }

    // 防脚本刷注册：同一来源每小时最多尝试若干次（独立于人机验证的第二道防线）。
    const clientIp = clientIpFromRequest(request);
    const rateLimit = checkRateLimit(`register:${clientIp}`, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
    if (!rateLimit.allowed) {
      return reply.code(429).send({
        message: `提交太频繁，请 ${Math.ceil(rateLimit.retryAfterSeconds / 60)} 分钟后再试。`,
      });
    }

    // 人机验证（配置了 Cloudflare Turnstile 时生效）。
    if (config.turnstile.enabled) {
      const token = body.turnstileToken?.trim();
      if (!token) {
        return reply.code(400).send({ message: "请先完成人机验证" });
      }
      const verified = await verifyTurnstileToken({
        secretKey: config.turnstile.secretKey,
        token,
        remoteIp: clientIp === "unknown" ? undefined : clientIp,
      });
      if (!verified.ok && !verified.infrastructureFailure) {
        request.log.warn({ errorCodes: verified.errorCodes, email }, "turnstile verification failed");
        return reply.code(400).send({ message: "人机验证未通过，请刷新页面后重试" });
      }
      if (verified.infrastructureFailure) {
        // 不因为 CF 抖动挡住正常用户，但要留下日志。
        request.log.warn({ email }, "turnstile verification unavailable, allowing registration");
      }
    }

    const user = await prisma.$transaction(async (tx) => {
      return tx.user.create({
        data: {
          qqUin: await generateSyntheticQqUin(tx),
          email,
          displayName: body.displayName,
          passwordHash: await hashPassword(body.password),
          passwordChangeRequired: false,
          isTestAccount: false,
          systemRole: "operations_admin",
          // 注册即提交开墙申请：默认 pending，系统运维审核通过后才能创建校园墙。
          tenantApplications: {
            create: {
              wallName: body.wallName,
              school: body.school || null,
              contact: body.contact || null,
              reason: body.reason || null,
              status: "pending",
            },
          },
        },
      });
    });

    const token = await createSession(user.id, null);
    setSessionCookie(reply, token);

    // 注册即提交申请：这里把申请状态一起返回，前端不需要额外请求就能进入「等待审核」。
    const application = await getLatestTenantApplication(user.id);
    const creationPermission = await resolveTenantCreationPermission(user);

    return {
      authenticated: true,
      user: toPublicUser(user),
      memberships: [],
      systemAccessibleTenants: [],
      currentTenant: null,
      currentMembership: null,
      activeBan: null,
      needsTenantSelection: false,
      hostLocked: false,
      tenantApplication: application ? toTenantApplicationSummary(application) : null,
      canCreateTenant: creationPermission.allowed,
      createTenantBlockedReason: creationPermission.allowed ? null : creationPermission.message,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = getCookie(request, sessionCookieName);
    if (token) {
      await prisma.accountSession.deleteMany({
        where: {
          tokenHash: hashToken(token),
        },
      });
    }

    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/password", async (request, reply) => {
    const context = await requireSession(request, reply);
    const body = changePasswordSchema.parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        id: context.user.id,
      },
    });

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ message: "当前密码不正确" });
    }

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        passwordChangeRequired: false,
      },
    });

    return { ok: true };
  });

  app.patch("/api/auth/profile", async (request, reply) => {
    const context = await requireSession(request, reply);
    const body = updateProfileSchema.parse(request.body);

    const user = await prisma.user.update({
      where: {
        id: context.user.id,
      },
      data: {
        displayName: body.displayName,
      },
    });

    return {
      ok: true,
      user: toPublicUser(user),
    };
  });

  app.post("/api/auth/password/required", async (request, reply) => {
    const context = await requireSession(request, reply);
    const body = requiredPasswordChangeSchema.parse(request.body);
    if (!context.user.passwordChangeRequired) {
      return reply.code(409).send({ message: "当前账号不需要强制修改密码" });
    }

    await prisma.user.update({
      where: {
        id: context.user.id,
      },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        passwordChangeRequired: false,
      },
    });

    return { ok: true };
  });

  app.get("/api/me", async (request) => {
    const context = await getSessionContext(request);
    if (!context) {
      return {
        authenticated: false,
      };
    }

    const systemAccessibleTenants = await listSystemAccessibleTenants(context.user.systemRole);
    const visibleMemberships = context.memberships.filter((membership) => membership.tenant.status !== "archived");
    const needsTenantSelection = !context.selectedTenant && (visibleMemberships.length > 1 || systemAccessibleTenants.length > 0);
    // 开墙申请状态：没有墙的运营者据此看到「审核中 / 已拒绝」页面，而不是直接进开墙向导。
    const application = await getLatestTenantApplication(context.user.id);
    const creationPermission = await resolveTenantCreationPermission(context.user);

    return {
      authenticated: true,
      user: toPublicUser(context.user),
      memberships: context.memberships.map(toMembership),
      systemAccessibleTenants,
      currentTenant: context.selectedTenant ? toTenantSummary(context.selectedTenant) : null,
      currentMembership: context.selectedMembership
        ? { id: context.selectedMembership.id, role: context.selectedMembership.role }
        : null,
      activeBan: toActiveBan(context.activeBan),
      needsTenantSelection,
      hostLocked: Boolean(context.hostTenant),
      tenantApplication: application ? toTenantApplicationSummary(application) : null,
      canCreateTenant: creationPermission.allowed,
      createTenantBlockedReason: creationPermission.allowed ? null : creationPermission.message,
    };
  });

  // 被拒绝后重新提交开墙申请（通过后即可创建校园墙）。
  app.post("/api/me/tenant-application", async (request, reply) => {
    const context = await getSessionContext(request);
    if (!context) {
      return reply.code(401).send({ message: "请先登录" });
    }
    const parsedApplication = registerApplicationSchema.safeParse(request.body ?? {});
    if (!parsedApplication.success) {
      return reply.code(400).send({
        message: parsedApplication.error.issues[0]?.message ?? "申请信息不完整，请检查后重试",
      });
    }
    const body = parsedApplication.data;
    const result = await submitTenantApplication({
      userId: context.user.id,
      wallName: body.wallName,
      school: body.school ?? null,
      contact: body.contact ?? null,
      reason: body.reason ?? null,
    });
    if (!result.ok) {
      return reply.code(409).send({ message: result.message, code: result.code });
    }
    return { ok: true, application: result.application };
  });

  app.patch("/api/me/settings", async (request, reply) => {
    const context = await getSessionContext(request);
    if (!context) {
      return reply.code(401).send({ message: "请先登录" });
    }
    const body = updateMeSettingsSchema.parse(request.body ?? {});
    if (body.autoFollowOwnPosts === undefined) {
      return { user: toPublicUser(context.user) };
    }
    const user = await prisma.user.update({
      where: { id: context.user.id },
      data: { autoFollowOwnPosts: body.autoFollowOwnPosts },
    });
    return { user: toPublicUser(user) };
  });

  app.post("/api/session/tenant", async (request, reply) => {
    const context = await getSessionContext(request);
    if (!context) {
      return reply.code(401).send({ message: "请先登录" });
    }

    const body = selectTenantSchema.parse(request.body);
    if (context.user.passwordChangeRequired) {
      return reply.code(403).send({ message: "请先修改初始密码" });
    }

    const hostTenant = await findTenantByRequestHost(request);
    if (hostTenant && body.tenantId !== hostTenant.id) {
      return reply.code(403).send({ message: "当前域名只能访问对应的校园墙" });
    }

    const membership = context.memberships.find((item) => item.tenantId === body.tenantId);
    const effectiveMembership = resolveEffectiveTenantMembership({
      userId: context.user.id,
      systemRole: context.user.systemRole,
      tenantId: body.tenantId,
      memberships: context.memberships,
    });
    if (!effectiveMembership) {
      return reply.code(403).send({ message: "没有访问该校园墙的权限" });
    }

    await prisma.accountSession.update({
      where: { id: context.session.id },
      data: { selectedTenantId: body.tenantId },
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: body.tenantId },
      include: {
        metadata: {
          where: {
            key: "logo_url",
          },
        },
        aiSettings: {
          select: {
            enabled: true,
          },
        },
        _count: {
          select: {
            botAccounts: true,
            posts: {
              where: {
                status: "pending_approval",
              },
            },
          },
        },
      },
    });

    return {
      ok: true,
      currentTenant: toTenantSummary(tenant),
      currentMembership: { id: effectiveMembership.id, role: effectiveMembership.role },
      activeBan: membership ? toActiveBan(await findActiveBan(body.tenantId, context.user.id)) : null,
    };
  });
}

async function generateSyntheticQqUin(tx: Prisma.TransactionClient) {
  for (let index = 0; index < 10; index += 1) {
    const candidate = BigInt(`8${Date.now()}${randomInt(100, 999)}`);
    const existing = await tx.user.findUnique({
      where: { qqUin: candidate },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
  }

  throw new Error("无法生成账号编号，请稍后再试");
}

function toActiveBan(ban: Awaited<ReturnType<typeof findActiveBan>>) {
  if (!ban) {
    return null;
  }

  return {
    id: ban.id,
    comment: ban.comment,
    startsAt: ban.startsAt.toISOString(),
    endsAt: ban.endsAt.toISOString(),
    createdAt: ban.createdAt.toISOString(),
  };
}

async function listSystemAccessibleTenants(systemRole: string | null) {
  if (systemRole !== "system_operator") {
    return [];
  }

  const tenants = await prisma.tenant.findMany({
    where: {
      status: {
        not: "archived",
      },
    },
    include: {
      metadata: {
        where: {
          key: "logo_url",
        },
      },
      aiSettings: {
        select: {
          enabled: true,
        },
      },
      _count: {
        select: {
          botAccounts: true,
          posts: {
            where: {
              status: "pending_approval",
            },
          },
        },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return tenants.map(toTenantSummary);
}
