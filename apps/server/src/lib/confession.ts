import type { FastifyBaseLogger } from "fastify";
import { CONFESSION_TEXT_MAX_LENGTH, CONFESSION_TEXT_MIN_LENGTH } from "@campux/domain";
import { normalizeBaseUrl, readTenantAiSettings, resolveTenantAiApiKey } from "../runtime/ai-settings";
import { prisma } from "./prisma";
import { isTenantRuntimeActive } from "./tenant-runtime";
import { readTenantPluginConfig, type TenantPluginConfig } from "./tenant-plugin-config";

/**
 * 青青子衿，悠悠我心 —— 双向表白。
 *
 * 规则：
 * - 甲向乙表白时只有甲知道（乙不会收到任何提示）；乙也向甲表白时才互相通知双方。
 * - 只能向本墙已注册用户表白，不能向自己表白，被封禁账号不能发也不能收。
 * - 每人每天有发送次数上限，重复向同一人表白会被拒绝（等对方回应即可）。
 * - 可选：表白正文先过大模型过滤（广告、辱骂、涉政、联系方式等直接不投递）。
 */

export type ConfessionSendCode =
  | "disabled"
  | "paused"
  | "invalid_target"
  | "invalid_text"
  | "self"
  | "target_not_found"
  | "sender_banned"
  | "target_banned"
  | "duplicate"
  | "matched_already"
  | "limit"
  | "screen_rejected";

export type ConfessionPartner = {
  qqUin: string;
  displayName: string | null;
  text: string;
};

export type ConfessionSendResult =
  | { ok: true; status: "pending"; remainingToday: number }
  | { ok: true; status: "matched"; partner: ConfessionPartner; partnerText: string }
  | { ok: false; code: ConfessionSendCode; message: string };

export type ConfessionRecordItem = {
  id: string;
  status: "pending" | "matched";
  text: string;
  createdAt: string;
  matchedAt: string | null;
  partnerQqUin: string;
  partnerDisplayName: string | null;
  /** 仅匹配成功后返回：对方写给自己的原话。 */
  partnerText: string | null;
};

const confessionScreenTimeoutMs = 20_000;

export function isConfessionEnabled(config: TenantPluginConfig) {
  return config.confessions.enabled;
}

export function getConfessionLimits(config: TenantPluginConfig) {
  return {
    dailyLimitPerUser: config.confessions.dailyLimitPerUser,
    maxTextLength: Math.min(config.confessions.maxTextLength, CONFESSION_TEXT_MAX_LENGTH),
    aiScreenEnabled: config.confessions.aiScreenEnabled,
    allowWebSubmit: config.confessions.allowWebSubmit,
  };
}

/**
 * 解析表白参数：QQ 号 + 正文。
 * 兼容全角空格、中英文冒号等常见输入习惯。
 */
export function parseConfessionArgs(args: string) {
  const normalized = args
    .replace(/[：:]/g, " ")
    .replace(/[，,]/g, " ")
    .replace(/\u3000/g, " ")
    .trim();
  const match = normalized.match(/^(\d{5,12})\s+(.+)$/s);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    targetQqUin: match[1],
    text: match[2].trim(),
  };
}

/**
 * 从私聊文本里取出表白命令的参数部分。
 *
 * 不用通用的 parseCommand 是因为中文输入法下常见「#表白：123456789 内容」这种
 * 没有空格分隔的写法，通用解析会把命令名拆成「表白：123456789」而识别失败。
 * 这里返回 null 表示「不是表白命令」，否则返回命令后的参数文本（可能为空串）。
 */
export function parseConfessionCommandText(input: string) {
  const normalized = input.trim().replace(/^@[^\s#＃/]+\s*/, "");
  const match = normalized.match(/^[#＃/]\s*表白\s*[：:，,、]?\s*([\s\S]*)$/);
  return match ? (match[1] ?? "").trim() : null;
}

export function normalizeConfessionText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 发送一条表白。命中互相表白时返回 matched，并已把两条记录标记为完成。
 */
export async function sendConfession(options: {
  tenantId: string;
  fromUserId: string;
  targetQqUin: string | bigint;
  text: string;
  notify: (qqUin: string, message: string) => Promise<unknown>;
  logger: FastifyBaseLogger;
  /** 网页端提交时的额外限制开关。 */
  requireWebSubmitAllowed?: boolean;
}): Promise<ConfessionSendResult> {
  const { tenantId, fromUserId, logger } = options;

  if (!await isTenantRuntimeActive(prisma, tenantId)) {
    return { ok: false, code: "paused", message: "校园墙已暂停或归档，暂时不能表白。" };
  }

  const config = await readTenantPluginConfig(prisma, tenantId);
  if (!config.confessions.enabled) {
    return { ok: false, code: "disabled", message: "本墙还没有开启「青青子衿」表白功能。" };
  }
  if (options.requireWebSubmitAllowed && !config.confessions.allowWebSubmit) {
    return { ok: false, code: "disabled", message: "本墙已关闭网页端表白，请通过墙号机器人私聊发送。" };
  }
  const limits = getConfessionLimits(config);

  const text = normalizeConfessionText(options.text);
  if (text.length < CONFESSION_TEXT_MIN_LENGTH || text.length > limits.maxTextLength) {
    return {
      ok: false,
      code: "invalid_text",
      message: `表白内容请控制在 ${CONFESSION_TEXT_MIN_LENGTH}-${limits.maxTextLength} 字之间。`,
    };
  }

  let targetQqUin: bigint;
  try {
    targetQqUin = BigInt(String(options.targetQqUin).trim());
  } catch {
    return { ok: false, code: "invalid_target", message: "QQ 号格式不对，请检查后重发。" };
  }
  if (targetQqUin <= 0n) {
    return { ok: false, code: "invalid_target", message: "QQ 号格式不对，请检查后重发。" };
  }

  const fromUser = await prisma.user.findUnique({
    where: { id: fromUserId },
    select: { id: true, qqUin: true, displayName: true },
  });
  if (!fromUser) {
    return { ok: false, code: "invalid_target", message: "账号状态异常，请先给机器人发送任意消息。" };
  }
  if (fromUser.qqUin === targetQqUin) {
    return { ok: false, code: "self", message: "不能向自己表白哦。" };
  }

  const banned = await findActiveBan(tenantId, fromUser.id);
  if (banned) {
    return { ok: false, code: "sender_banned", message: `账号已被封禁：${banned}` };
  }

  const targetUser = await prisma.user.findUnique({
    where: { qqUin: targetQqUin },
    select: { id: true, qqUin: true, displayName: true },
  });
  const targetMembership = targetUser
    ? await prisma.tenantMembership.findFirst({ where: { tenantId, userId: targetUser.id }, select: { id: true } })
    : null;
  if (!targetUser || !targetMembership) {
    return {
      ok: false,
      code: "target_not_found",
      message: `QQ ${targetQqUin} 还没有在本墙注册，暂时不能向 TA 表白。`,
    };
  }
  const targetBan = await findActiveBan(tenantId, targetUser.id);
  if (targetBan) {
    return { ok: false, code: "target_banned", message: "对方当前已被封禁，暂时不能向 TA 表白。" };
  }

  // 已经互相表白过的两个人不需要再走一次「悄悄表白」流程。
  const existingMatched = await prisma.confession.findFirst({
    where: { tenantId, fromUserId: fromUser.id, toUserId: targetUser.id, status: "matched" },
    select: { id: true },
  });
  if (existingMatched) {
    return { ok: false, code: "matched_already", message: "你们已经互相表白过啦，直接找 TA 聊天吧～" };
  }

  if (limits.dailyLimitPerUser > 0) {
    const usedToday = await countTodayConfessions(tenantId, fromUser.id);
    if (usedToday >= limits.dailyLimitPerUser) {
      return { ok: false, code: "limit", message: `今天已经表白过 ${usedToday} 次啦，明天再来吧。` };
    }
  }

  const existingPending = await prisma.confession.findFirst({
    where: { tenantId, fromUserId: fromUser.id, toUserId: targetUser.id, status: "pending" },
    select: { id: true, text: true },
  });
  if (existingPending) {
    const usedTodayForExisting = await countTodayConfessions(tenantId, fromUser.id);
    const remainingForExisting = limits.dailyLimitPerUser > 0
      ? Math.max(0, limits.dailyLimitPerUser - usedTodayForExisting)
      : 0;
    // 极端并发下可能出现「双方各有条待回应但都没匹配」的卡住状态：
    // 重复表白时再尝试一次配对，让这种情况能自愈。
    const recovered = await completeMutualMatchIfPossible({
      tenantId,
      fromUser,
      targetUser,
      myText: existingPending.text,
      notify: options.notify,
      logger,
      remainingToday: remainingForExisting,
    });
    if (recovered) {
      return recovered;
    }
    return { ok: false, code: "duplicate", message: "你已经向 TA 表白过了，等 TA 也向你表白就会互相通知。" };
  }

  if (limits.aiScreenEnabled) {
    const screening = await screenConfessionText({ tenantId, text, logger });
    if (!screening.allowed) {
      return {
        ok: false,
        code: "screen_rejected",
        message: screening.reason ?? "这条表白不适合投递，请修改后重发。",
      };
    }
  }

  try {
    await prisma.confession.create({
      data: {
        tenantId,
        fromUserId: fromUser.id,
        toUserId: targetUser.id,
        text,
        status: "pending",
      },
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { ok: false, code: "duplicate", message: "你已经向 TA 表白过了，等 TA 也向你表白就会互相通知。" };
    }
    throw error;
  }

  const usedToday = await countTodayConfessions(tenantId, fromUser.id);
  const remainingToday = limits.dailyLimitPerUser > 0
    ? Math.max(0, limits.dailyLimitPerUser - usedToday)
    : 0;

  const matched = await completeMutualMatchIfPossible({
    tenantId,
    fromUser,
    targetUser,
    myText: text,
    notify: options.notify,
    logger,
    remainingToday,
  });
  return matched ?? { ok: true, status: "pending", remainingToday };
}

/**
 * 若对方也已向自己表白，把两条待回应记录一起标记为已匹配，并互相通知双方。
 * 没有反向记录时返回 null（调用方按「单方表白」处理）。
 */
async function completeMutualMatchIfPossible(options: {
  tenantId: string;
  fromUser: { id: string; qqUin: bigint; displayName: string | null };
  targetUser: { id: string; qqUin: bigint; displayName: string | null };
  myText: string;
  notify: (qqUin: string, message: string) => Promise<unknown>;
  logger: FastifyBaseLogger;
  remainingToday: number;
}): Promise<Extract<ConfessionSendResult, { ok: true; status: "matched" }> | null> {
  const { tenantId, fromUser, targetUser, logger } = options;
  const reverse = await prisma.confession.findFirst({
    where: { tenantId, fromUserId: targetUser.id, toUserId: fromUser.id, status: "pending" },
    select: { id: true, text: true },
  });
  if (!reverse) {
    return null;
  }

  const matchedAt = new Date();
  await prisma.$transaction([
    prisma.confession.updateMany({
      where: { tenantId, fromUserId: targetUser.id, toUserId: fromUser.id, status: "pending" },
      data: { status: "matched", matchedAt },
    }),
    prisma.confession.updateMany({
      where: { tenantId, fromUserId: fromUser.id, toUserId: targetUser.id, status: "pending" },
      data: { status: "matched", matchedAt },
    }),
  ]);

  const myMessage = formatConfessionMatch({
    partnerQqUin: targetUser.qqUin,
    partnerDisplayName: targetUser.displayName,
    myText: options.myText,
    partnerText: reverse.text,
  });
  const partnerMessage = formatConfessionMatch({
    partnerQqUin: fromUser.qqUin,
    partnerDisplayName: fromUser.displayName,
    myText: reverse.text,
    partnerText: options.myText,
  });
  await options.notify(fromUser.qqUin.toString(), myMessage).catch((error) => {
    logger.warn({ error, tenantId, userId: fromUser.id }, "confession: failed to notify sender about match");
  });
  await options.notify(targetUser.qqUin.toString(), partnerMessage).catch((error) => {
    logger.warn({ error, tenantId, userId: targetUser.id }, "confession: failed to notify target about match");
  });
  logger.info(
    { tenantId, fromUserId: fromUser.id, toUserId: targetUser.id },
    "confession: mutual match created",
  );

  return {
    ok: true,
    status: "matched",
    partner: {
      qqUin: targetUser.qqUin.toString(),
      displayName: targetUser.displayName,
      text: reverse.text,
    },
    partnerText: reverse.text,
  };
}

export async function countTodayConfessions(tenantId: string, fromUserId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return prisma.confession.count({
    where: { tenantId, fromUserId, createdAt: { gte: startOfDay } },
  });
}

/** 我发出的表白（匹配成功后附带对方写给我的原话）。未匹配的收件记录不返回，保证匿名性。 */
export async function listMyConfessions(tenantId: string, userId: string): Promise<ConfessionRecordItem[]> {
  const sent = await prisma.confession.findMany({
    where: { tenantId, fromUserId: userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { toUser: { select: { qqUin: true, displayName: true } } },
  });
  if (sent.length === 0) {
    return [];
  }

  const matchedPairs = sent.filter((item) => item.status === "matched");
  const partnerTexts = new Map<string, string>();
  if (matchedPairs.length > 0) {
    const replies = await prisma.confession.findMany({
      where: {
        tenantId,
        status: "matched",
        fromUserId: { in: matchedPairs.map((item) => item.toUserId) },
        toUserId: userId,
      },
      select: { fromUserId: true, text: true },
    });
    for (const reply of replies) {
      partnerTexts.set(reply.fromUserId, reply.text);
    }
  }

  return sent.map((item) => ({
    id: item.id,
    status: item.status === "matched" ? "matched" : "pending",
    text: item.text,
    createdAt: item.createdAt.toISOString(),
    matchedAt: item.matchedAt?.toISOString() ?? null,
    partnerQqUin: item.toUser.qqUin.toString(),
    partnerDisplayName: item.toUser.displayName,
    partnerText: item.status === "matched" ? partnerTexts.get(item.toUserId) ?? null : null,
  }));
}

/** 管理端：本墙全部表白记录（用于风控与纠纷处理）。 */
export async function listTenantConfessions(options: {
  tenantId: string;
  status?: "pending" | "matched" | "all";
  page: number;
  limit: number;
}) {
  const where = {
    tenantId: options.tenantId,
    ...(options.status && options.status !== "all" ? { status: options.status } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.confession.count({ where }),
    prisma.confession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      include: {
        fromUser: { select: { qqUin: true, displayName: true } },
        toUser: { select: { qqUin: true, displayName: true } },
      },
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      status: item.status === "matched" ? "matched" : "pending",
      text: item.text,
      createdAt: item.createdAt.toISOString(),
      matchedAt: item.matchedAt?.toISOString() ?? null,
      fromQqUin: item.fromUser.qqUin.toString(),
      fromDisplayName: item.fromUser.displayName,
      toQqUin: item.toUser.qqUin.toString(),
      toDisplayName: item.toUser.displayName,
    })),
    page: options.page,
    limit: options.limit,
    total,
    pageCount: Math.max(1, Math.ceil(total / options.limit)),
  };
}

export function formatConfessionAccepted(remainingToday: number) {
  const tail = remainingToday > 0 ? `\n今天还可以表白 ${remainingToday} 次。` : "";
  return [
    "💌 表白已经悄悄记下了。",
    "对方不会收到任何提示；如果 TA 也向你表白，你们会同时收到通知。",
  ].join("\n") + tail;
}

export function formatConfessionMatch(options: {
  partnerQqUin: string | bigint;
  partnerDisplayName: string | null;
  myText: string;
  partnerText: string;
}) {
  const name = options.partnerDisplayName?.trim();
  const partnerLabel = name ? `${name}（${options.partnerQqUin}）` : `${options.partnerQqUin}`;
  return [
    "🎉 青青子衿，悠悠我心",
    `你和 ${partnerLabel} 互相表白了！`,
    "",
    `TA 对你说：${options.partnerText}`,
    `你对 TA 说：${options.myText}`,
  ].join("\n");
}

async function findActiveBan(tenantId: string, userId: string) {
  const ban = await prisma.banRecord.findFirst({
    where: { tenantId, userId, endsAt: { gt: new Date() } },
    orderBy: { endsAt: "desc" },
    select: { comment: true },
  });
  return ban?.comment ?? null;
}

/** 用租户配置的模型过滤表白正文；任何异常都放行（表白只有双方互相喜欢才会送达）。 */
async function screenConfessionText(options: {
  tenantId: string;
  text: string;
  logger: FastifyBaseLogger;
}): Promise<{ allowed: boolean; reason: string | null }> {
  const settings = await readTenantAiSettings(options.tenantId).catch(() => null);
  if (!settings || !settings.enabled || settings.mode !== "llm" || !settings.apiKeyConfigured) {
    return { allowed: true, reason: null };
  }
  const apiKey = await resolveTenantAiApiKey(options.tenantId, {});
  if (!apiKey) {
    return { allowed: true, reason: null };
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), confessionScreenTimeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: settings.model,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是校园墙表白内容的初审员。只返回 JSON，不要 Markdown。",
            "判断这段表白是否适合投递给对方。",
            "拒绝：广告引流（微商、兼职、拉群、导流链接）、诈骗、色情低俗、政治敏感、辱骂威胁、暴露他人隐私或联系方式（手机号、微信号、住址、真实姓名搭配班级等）。",
            "允许：正常的表白、暗恋、道歉、问候、赞美等个人情感表达，包括口语和轻微脏话。",
            `返回 JSON：{"allowed":true|false,"reason":"不允许时给投稿人看的一句话原因，否则 null"}`,
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify({ text: options.text }) },
      ],
    };
    if (baseUrl.includes("deepseek")) {
      body.thinking = { type: "disabled" };
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      options.logger.warn({ tenantId: options.tenantId, status: response.status }, "confession screen: LLM request failed");
      return { allowed: true, reason: null };
    }
    const data = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    const parsed = parseJsonObject(data?.choices?.[0]?.message?.content ?? "");
    if (!parsed) {
      return { allowed: true, reason: null };
    }
    if (parsed.allowed === false) {
      return {
        allowed: false,
        reason: typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 120)
          : "这条表白不适合投递，请修改后重发。",
      };
    }
    return { allowed: true, reason: null };
  } catch (error) {
    options.logger.warn({ error, tenantId: options.tenantId }, "confession screen: errored, allowing by default");
    return { allowed: true, reason: null };
  } finally {
    clearTimeout(timeout);
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!trimmed) {
    return null;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
