import type { FastifyBaseLogger } from "fastify";
import { DEFAULT_POST_REVIEW_RULES } from "@campux/domain";
import { normalizeBaseUrl, readTenantAiSettings, resolveTenantAiApiKey, type TenantAiSettingsPayload } from "./ai-settings";
import { writeAuditLog } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { readTenantPublishMode } from "../lib/tenant-metadata";
import { isTenantRuntimeActive } from "../lib/tenant-runtime";
import { runWithActiveTenantLease } from "../lib/tenant-runtime-lease";
import { addApprovedPostToBatch } from "./publish-batching";
import { enqueuePublishFanout } from "./publishing";
import type { RuntimeQueue } from "./queue";
import type { OneBotRuntime } from "./onebot";

/**
 * 投稿 AI 初审。
 *
 * 设计原则（与 Campux 官方 AI 审核设计文档一致）：
 * - AI 只做「建议」，是否可以自动执行由租户设置里的开关和阈值决定。
 * - 任何异常（超时、返回格式错误、配置不全）都不能影响投稿本身，一律保持待审。
 * - 自动通过走的是和人工审核完全相同的链路（改状态 + 写日志 + 触发发布），
 *   所以审核员看到的记录、发布行为、统计口径都和人工通过一致，只是 actorId 为空。
 * - 含附件的稿件默认转人工，AI 不判断图片/视频内容。
 */

export type PostReviewAction = "approve" | "manual_review" | "reject";
export type PostReviewRiskLevel = "low" | "medium" | "high";

export type PostReviewVerdict = {
  riskLevel: PostReviewRiskLevel;
  suggestedAction: PostReviewAction;
  confidence: number;
  categories: string[];
  reasons: string[];
  sensitiveFindings: string[];
  rejectionReason: string | null;
  /** 原始输出，便于排查模型判断。 */
  raw: string;
};

const reviewMaxTextChars = 2000;
const reviewMaxTokens = 800;
const reviewMinTimeoutSeconds = 10;
const reviewMaxTimeoutSeconds = 45;
const reviewCommentMaxChars = 400;
const defaultAutoApproveThreshold = 0.9;
const defaultAutoRejectThreshold = 0.85;
const defaultDailyLimit = 200;
const aiApproveCommentPrefix = "AI 自动审核通过";

const outputSchema = {
  riskLevel: "low | medium | high",
  suggestedAction: "approve | manual_review | reject",
  confidence: "0 到 1 的小数",
  categories: ["命中类型，如 政治敏感 / 恶意攻击 / 广告引流 / 隐私泄露 / 正常"],
  reasons: ["一句话说明判断依据"],
  sensitiveFindings: ["稿件里具体触发风险的原句片段，没有则为空数组"],
  rejectionReason: "suggestedAction 为 reject 时给投稿人看的一句话理由，否则 null",
};

/**
 * 对一条待审核稿件跑 AI 初审。
 *
 * 调用方只需要 fire-and-forget 地调用它（.catch 记录日志），它自己会吞掉所有异常。
 */
export async function aiReviewPost(options: {
  tenantId: string;
  postId: string;
  logger: FastifyBaseLogger;
  queue: RuntimeQueue;
  oneBot?: OneBotRuntime | undefined;
}): Promise<void> {
  const { tenantId, postId, logger } = options;
  try {
    if (!await isTenantRuntimeActive(prisma, tenantId)) {
      return;
    }

    const settings = await readTenantAiSettings(tenantId).catch((error) => {
      logger.warn({ error, tenantId }, "ai review: failed to read tenant AI settings");
      return null;
    });
    if (!settings || !settings.enabled || settings.mode !== "llm" || !settings.apiKeyConfigured) {
      return;
    }
    const rules = settings.rules;
    if (!rules.postReviewEnabled) {
      return;
    }

    const post = await prisma.post.findFirst({
      where: { id: postId, tenantId },
      select: {
        id: true,
        displayId: true,
        text: true,
        attachments: true,
        status: true,
      },
    });
    if (!post || post.status !== "pending_approval") {
      return;
    }

    const attachmentCount = Array.isArray(post.attachments) ? post.attachments.length : 0;
    if (attachmentCount > 0) {
      await appendReviewLog(tenantId, post.id, `AI 预审：含 ${attachmentCount} 个附件，按设置转人工审核`);
      return;
    }

    const text = post.text.trim();
    if (!text) {
      return;
    }

    const apiKey = await resolveTenantAiApiKey(tenantId, {});
    if (!apiKey) {
      return;
    }

    const verdict = await requestPostReviewVerdict({
      tenantId,
      settings,
      apiKey,
      wallRules: rules.postReviewRules?.trim() || DEFAULT_POST_REVIEW_RULES,
      text,
      logger,
    });
    if (!verdict) {
      logger.warn({ tenantId, postId: post.id }, "ai review: no usable verdict, keeping post for human review");
      return;
    }

    const approveThreshold = clampUnit(rules.postReviewAutoApproveThreshold, defaultAutoApproveThreshold);
    const rejectThreshold = clampUnit(rules.postReviewAutoRejectThreshold, defaultAutoRejectThreshold);
    const dailyLimit = normalizeDailyLimit(rules.postReviewDailyLimit);

    if (
      verdict.suggestedAction === "approve"
      && verdict.riskLevel === "low"
      && verdict.confidence >= approveThreshold
      && verdict.sensitiveFindings.length === 0
    ) {
      if (rules.postReviewAutoApprove !== true) {
        await appendReviewLog(tenantId, post.id, buildAdvisoryComment(verdict, "建议通过"));
        return;
      }
      if (dailyLimit > 0) {
        const approvedToday = await countTodayAiApprovals(tenantId);
        if (approvedToday >= dailyLimit) {
          await appendReviewLog(tenantId, post.id, buildAdvisoryComment(verdict, "建议通过（已达每日自动通过上限，转人工）"));
          return;
        }
      }
      await approvePostByAi({ tenantId, post, verdict, settings, queue: options.queue, logger });
      return;
    }

    if (verdict.suggestedAction === "reject" && verdict.riskLevel === "high" && verdict.confidence >= rejectThreshold) {
      if (rules.postReviewAutoReject !== true) {
        await appendReviewLog(tenantId, post.id, buildAdvisoryComment(verdict, "建议拒绝"));
        return;
      }
      await rejectPostByAi({ tenantId, post, verdict, settings, oneBot: options.oneBot, logger });
      return;
    }

    await appendReviewLog(tenantId, post.id, buildAdvisoryComment(verdict, "建议人工复核"));
  } catch (error) {
    // AI 初审永远不能让投稿链路受影响，出错就交给人工。
    logger.warn({ error, tenantId, postId }, "ai review: unexpected failure");
  }
}

async function requestPostReviewVerdict(options: {
  tenantId: string;
  settings: TenantAiSettingsPayload;
  apiKey: string;
  wallRules: string;
  text: string;
  logger: FastifyBaseLogger;
}): Promise<PostReviewVerdict | null> {
  const { tenantId, settings, apiKey, wallRules, text, logger } = options;
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const timeoutSeconds = Math.min(Math.max(settings.timeoutSeconds, reviewMinTimeoutSeconds), reviewMaxTimeoutSeconds);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);

  const body: Record<string, unknown> = {
    model: settings.model,
    temperature: 0,
    max_tokens: reviewMaxTokens,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是校园墙的投稿初审员。只返回 JSON，不要 Markdown，不要多余文字。",
          "只能依据下面这份墙规和稿件正文判断，不要臆造稿件里没有的事实。",
          "墙规：",
          wallRules,
          "判定口径：",
          "1. 明确命中拒绝项，且你很有把握：suggestedAction=reject，riskLevel=high。",
          "2. 拿不准、可能违规、或需要结合上下文才能判断：suggestedAction=manual_review，riskLevel=medium。",
          "3. 符合墙规且没有任何隐私或攻击性风险：suggestedAction=approve，riskLevel=low；只有非常有把握时 confidence 才给 0.9 以上。",
          "4. 宁可转人工，也不要放过违规内容；但也不要因为正常的情绪表达、口头语、吐槽老师就转人工。",
          `返回 JSON，格式示例：${JSON.stringify(outputSchema)}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          post: {
            text: text.slice(0, reviewMaxTextChars),
            truncated: text.length > reviewMaxTextChars,
            hasAttachments: false,
          },
        }),
      },
    ],
  };
  // DeepSeek 默认开启思考模式，思考 token 按输出计费；审核这类分类任务不需要它。
  // 只对 DeepSeek 官方端点附加该参数，避免其它 OpenAI 兼容服务因未知字段报错。
  if (baseUrl.includes("deepseek")) {
    body.thinking = { type: "disabled" };
  }

  try {
    const leased = await runWithActiveTenantLease(prisma, tenantId, async () => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as
        | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
        | null;
      return { response, data };
    });
    if (!leased.active) {
      return null;
    }
    const { response, data } = leased.value;
    if (!response.ok) {
      logger.warn(
        { tenantId, status: response.status, error: data?.error?.message },
        "ai review: LLM request failed",
      );
      return null;
    }
    return parsePostReviewVerdict(data?.choices?.[0]?.message?.content ?? "");
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    logger.warn({ error, tenantId, aborted }, "ai review: LLM call errored");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function parsePostReviewVerdict(raw: string): PostReviewVerdict | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }
  const suggestedAction: PostReviewAction = parsed.suggestedAction === "approve" || parsed.suggestedAction === "reject"
    ? parsed.suggestedAction
    : "manual_review";
  const riskLevel: PostReviewRiskLevel = parsed.riskLevel === "low" || parsed.riskLevel === "high"
    ? parsed.riskLevel
    : "medium";
  return {
    riskLevel,
    suggestedAction,
    confidence: clampUnit(parsed.confidence, 0.5),
    categories: normalizeStringList(parsed.categories).slice(0, 6),
    reasons: normalizeStringList(parsed.reasons).slice(0, 4),
    sensitiveFindings: normalizeStringList(parsed.sensitiveFindings).slice(0, 6),
    rejectionReason: typeof parsed.rejectionReason === "string" && parsed.rejectionReason.trim()
      ? parsed.rejectionReason.trim().slice(0, 200)
      : null,
    raw,
  };
}

async function approvePostByAi(options: {
  tenantId: string;
  post: { id: string; displayId: number };
  verdict: PostReviewVerdict;
  settings: TenantAiSettingsPayload;
  queue: RuntimeQueue;
  logger: FastifyBaseLogger;
}) {
  const { tenantId, post, verdict, settings, queue, logger } = options;
  const comment = buildAiComment(aiApproveCommentPrefix, verdict);

  const approved = await runWithActiveTenantLease(prisma, tenantId, async (transaction) => {
    const updated = await transaction.post.updateMany({
      where: { id: post.id, tenantId, status: "pending_approval" },
      data: { status: "approved" },
    });
    if (updated.count === 0) {
      return null;
    }
    await transaction.postLog.create({
      data: {
        tenantId,
        postId: post.id,
        actorId: null,
        oldStatus: "pending_approval",
        newStatus: "approved",
        comment,
      },
    });
    await writeAuditLog({
      tenantId,
      actorId: null,
      action: "post.approve",
      targetType: "post",
      targetId: post.id,
      detail: {
        displayId: post.displayId,
        ai: true,
        model: settings.model,
        riskLevel: verdict.riskLevel,
        confidence: verdict.confidence,
        categories: verdict.categories,
        reasons: verdict.reasons,
      },
    }, transaction);
    return readTenantPublishMode(transaction, tenantId);
  });
  if (!approved.active || !approved.value) {
    return;
  }

  // 与人工通过后的发布链路保持一致：攒批模式进批次，否则立刻排队发布。
  if (approved.value.mode === "accumulate") {
    await addApprovedPostToBatch(queue, tenantId, post.id, null, logger);
  } else {
    await enqueuePublishFanout(queue, tenantId, post.id, null);
  }
  logger.info(
    { tenantId, postId: post.id, displayId: post.displayId, confidence: verdict.confidence },
    "ai review: post auto approved",
  );
}

async function rejectPostByAi(options: {
  tenantId: string;
  post: { id: string; displayId: number };
  verdict: PostReviewVerdict;
  settings: TenantAiSettingsPayload;
  oneBot?: OneBotRuntime | undefined;
  logger: FastifyBaseLogger;
}) {
  const { tenantId, post, verdict, settings, oneBot, logger } = options;
  const rejectionReason = verdict.rejectionReason ?? verdict.reasons[0] ?? "内容不符合本墙投稿规范";
  const comment = buildAiComment(`AI 自动审核拒绝：${rejectionReason}`, verdict);

  const rejected = await runWithActiveTenantLease(prisma, tenantId, async (transaction) => {
    const updated = await transaction.post.updateMany({
      where: { id: post.id, tenantId, status: "pending_approval" },
      data: { status: "rejected" },
    });
    if (updated.count === 0) {
      return null;
    }
    await transaction.postLog.create({
      data: {
        tenantId,
        postId: post.id,
        actorId: null,
        oldStatus: "pending_approval",
        newStatus: "rejected",
        comment,
      },
    });
    await writeAuditLog({
      tenantId,
      actorId: null,
      action: "post.reject",
      targetType: "post",
      targetId: post.id,
      detail: {
        displayId: post.displayId,
        ai: true,
        model: settings.model,
        riskLevel: verdict.riskLevel,
        confidence: verdict.confidence,
        categories: verdict.categories,
        reasons: verdict.reasons,
        sensitiveFindings: verdict.sensitiveFindings,
        rejectionReason,
      },
    }, transaction);
    return true;
  });
  if (!rejected.active || !rejected.value) {
    return;
  }

  oneBot?.notifyReviewResult(post.id, "rejected", rejectionReason).catch((error) => {
    logger.warn({ error, postId: post.id }, "ai review: failed to notify author about rejection");
  });
  logger.info(
    { tenantId, postId: post.id, displayId: post.displayId, confidence: verdict.confidence, categories: verdict.categories },
    "ai review: post auto rejected",
  );
}

async function appendReviewLog(tenantId: string, postId: string, comment: string) {
  await prisma.postLog.create({
    data: {
      tenantId,
      postId,
      actorId: null,
      oldStatus: "pending_approval",
      newStatus: "pending_approval",
      comment: truncate(comment, reviewCommentMaxChars),
    },
  });
}

async function countTodayAiApprovals(tenantId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return prisma.postLog.count({
    where: {
      tenantId,
      actorId: null,
      newStatus: "approved",
      createdAt: { gte: startOfDay },
      comment: { startsWith: aiApproveCommentPrefix },
    },
  });
}

function buildAiComment(prefix: string, verdict: PostReviewVerdict) {
  const reason = verdict.reasons[0] ? `：${verdict.reasons[0]}` : "";
  return truncate(`${prefix}（${riskLabel(verdict.riskLevel)}，置信度 ${Math.round(verdict.confidence * 100)}%）${reason}`, reviewCommentMaxChars);
}

function buildAdvisoryComment(verdict: PostReviewVerdict, label: string) {
  const reason = verdict.reasons[0] ? `：${verdict.reasons[0]}` : "";
  const categories = verdict.categories.length > 0 ? `，类型 ${verdict.categories.join("/")}` : "";
  return truncate(`AI 预审：${label}（${riskLabel(verdict.riskLevel)}${categories}，置信度 ${Math.round(verdict.confidence * 100)}%）${reason}`, reviewCommentMaxChars);
}

function riskLabel(riskLevel: PostReviewRiskLevel) {
  if (riskLevel === "low") {
    return "低风险";
  }
  return riskLevel === "high" ? "高风险" : "中风险";
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((item) => {
      if (typeof item === "string") {
        return [item.trim()];
      }
      if (typeof item === "number") {
        return [String(item)];
      }
      return [];
    })
    .filter(Boolean);
}

function clampUnit(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeDailyLimit(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return defaultDailyLimit;
  }
  return Math.max(0, Math.min(2000, Math.trunc(numeric)));
}

function truncate(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
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
