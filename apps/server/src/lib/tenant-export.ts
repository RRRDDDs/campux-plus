import { prisma } from "./prisma";

/**
 * 把 Prisma 查询结果转换成可安全 JSON 化的结构。
 * 主要是把 BigInt（QQ 号）转成字符串——直接 JSON.stringify 会抛
 * "Do not know how to serialize a BigInt"。
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonSafe(item)]),
    );
  }
  return value;
}

/**
 * 导出某个校园墙的完整数据（用于删除前的备份）。
 *
 * 返回可直接落盘为 JSON 的对象。注意：其中包含投稿内容、表白内容与机器人登录态，
 * 属于敏感数据，只应交给系统运维本人保管。
 */
export async function buildTenantExportBundle(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      metadata: true,
      aiSettings: true,
      memberships: {
        include: {
          user: { select: { id: true, qqUin: true, email: true, displayName: true, createdAt: true } },
        },
      },
      postTags: true,
      botAccounts: {
        include: {
          sessions: true,
          publishTargets: true,
        },
      },
      publishBatches: {
        include: { items: true },
      },
      campaigns: {
        include: { options: true },
      },
    },
  });
  if (!tenant) {
    return null;
  }

  const [posts, confessions, counts] = await Promise.all([
    prisma.post.findMany({
      where: { tenantId },
      orderBy: { displayId: "asc" },
      include: {
        logs: { orderBy: { createdAt: "asc" } },
        tagAssignments: { include: { tag: { select: { name: true } } } },
      },
    }),
    prisma.confession.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    Promise.all([
      prisma.post.count({ where: { tenantId } }),
      prisma.auditLog.count({ where: { tenantId } }),
      prisma.postFollow.count({ where: { post: { tenantId } } }),
      prisma.qZonePostMetric.count({ where: { tenantId } }),
    ]),
  ]);

  const [postCount, auditLogCount, followCount, metricCount] = counts;

  return toJsonSafe({
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    counts: {
      posts: postCount,
      members: tenant.memberships.length,
      auditLogs: auditLogCount,
      postFollows: followCount,
      qzoneMetrics: metricCount,
      confessions: confessions.length,
      botAccounts: tenant.botAccounts.length,
    },
    tenant: {
      ...tenant,
      metadata: undefined,
      aiSettings: undefined,
      memberships: undefined,
      postTags: undefined,
      botAccounts: undefined,
      publishBatches: undefined,
      campaigns: undefined,
    },
    metadata: tenant.metadata,
    aiSettings: tenant.aiSettings,
    memberships: tenant.memberships,
    postTags: tenant.postTags,
    botAccounts: tenant.botAccounts,
    publishBatches: tenant.publishBatches,
    campaigns: tenant.campaigns,
    posts,
    confessions,
  }) as Record<string, unknown>;
}
