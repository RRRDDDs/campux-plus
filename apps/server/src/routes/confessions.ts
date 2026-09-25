import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireReadyTenant, requireTenantRole } from "../lib/auth";
import {
  countTodayConfessions,
  getConfessionLimits,
  listMyConfessions,
  listTenantConfessions,
  sendConfession,
} from "../lib/confession";
import { prisma } from "../lib/prisma";
import { readTenantPluginConfig } from "../lib/tenant-plugin-config";
import type { OneBotRuntime } from "../runtime/onebot";

const sendBodySchema = z.object({
  toQq: z.union([z.string().trim().min(5).max(12), z.number().int().positive()]),
  text: z.string().trim().min(1).max(400),
});

const adminQuerySchema = z.object({
  status: z.enum(["all", "pending", "matched"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function registerConfessionRoutes(app: FastifyInstance, oneBot?: OneBotRuntime) {
  /** 我的表白：发出的记录（匹配成功后附带对方原话）与限额。 */
  app.get("/api/confessions/overview", async (request, reply) => {
    const context = await requireReadyTenant(request, reply, "submitter");
    const tenantId = context.selectedTenant.id;
    const config = await readTenantPluginConfig(prisma, tenantId);
    const limits = getConfessionLimits(config);
    const [items, usedToday] = await Promise.all([
      config.confessions.enabled ? listMyConfessions(tenantId, context.user.id) : Promise.resolve([]),
      countTodayConfessions(tenantId, context.user.id),
    ]);

    return {
      enabled: config.confessions.enabled,
      limits,
      usedToday,
      myQqUin: context.user.qqUin.toString(),
      items,
    };
  });

  /** 网页端发起表白（与机器人私聊走同一套校验与匹配逻辑）。 */
  app.post("/api/confessions", async (request, reply) => {
    const context = await requireReadyTenant(request, reply, "submitter");
    const parsedBody = sendBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ ok: false, message: "请求参数不正确，请检查对方的 QQ 号和表白内容。", code: "invalid_request" });
    }
    const body = parsedBody.data;
    const tenantId = context.selectedTenant.id;

    const result = await sendConfession({
      tenantId,
      fromUserId: context.user.id,
      targetQqUin: String(body.toQq),
      text: body.text,
      notify: oneBot
        ? (qqUin, message) => oneBot.sendPrivateMessageViaTenantBots(tenantId, qqUin, message)
        : async () => undefined,
      logger: request.log,
      requireWebSubmitAllowed: true,
    });

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.message, code: result.code });
    }
    return {
      ok: true,
      status: result.status,
      ...(result.status === "matched" ? { partner: result.partner } : { remainingToday: result.remainingToday }),
    };
  });

  /** 管理端：本墙全部表白记录（风控与纠纷处理用）。 */
  app.get("/api/admin/confessions", async (request, reply) => {
    const context = await requireTenantRole(request, reply, "admin");
    const parsedQuery = adminQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ message: "查询参数不正确" });
    }
    const query = parsedQuery.data;
    const tenantId = context.selectedTenant.id;
    const config = await readTenantPluginConfig(prisma, tenantId);
    const result = await listTenantConfessions({
      tenantId,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
    return {
      ...result,
      enabled: config.confessions.enabled,
      limits: getConfessionLimits(config),
    };
  });
}
