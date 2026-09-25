import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HeartIcon, LockIcon, SendIcon, SparklesIcon } from "lucide-react";
import { api } from "@/lib/api";
import { LoadingBlock } from "@/components/app/utility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConfessionItem, ConfessionOverview } from "@/types/app";

/**
 * 青青子衿，悠悠我心 —— 表白页。
 *
 * 只有匹配成功的记录会展示对方身份与原话；单方表白在对方侧完全不可见。
 */
export function ConfessionsPage({ tenantId, active, currentUserId }: { tenantId: string; active: boolean; currentUserId: string }) {
  const [overview, setOverview] = useState<ConfessionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toQq, setToQq] = useState("");
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ConfessionOverview>("/api/confessions/overview");
      setOverview(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载表白数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, load, tenantId, currentUserId]);

  async function submit() {
    if (submitting) {
      return;
    }
    const target = toQq.trim();
    const body = text.trim();
    if (!/^\d{5,12}$/.test(target)) {
      toast.error("请填写对方的 QQ 号（5-12 位数字）");
      return;
    }
    if (body.length < 2) {
      toast.error("写点什么再发吧");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api<{ ok: boolean; status: "pending" | "matched"; remainingToday?: number }>("/api/confessions", {
        method: "POST",
        body: JSON.stringify({ toQq: target, text: body }),
      });
      setText("");
      if (result.status === "matched") {
        toast.success("🎉 你们互相表白了！机器人已私聊通知双方");
      } else {
        toast.success("💌 表白已悄悄记下，对方不会收到提示");
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !overview) {
    return <LoadingBlock title="正在加载表白数据" />;
  }

  if (overview && !overview.enabled) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md rounded-md border-slate-200 bg-white shadow-none">
          <CardContent className="space-y-2 p-6 text-center">
            <HeartIcon className="mx-auto size-8 text-slate-300" />
            <p className="text-base font-semibold text-slate-900">本墙还没有开启「青青子衿」</p>
            <p className="text-sm text-slate-500">管理员在「管理 → 插件配置」里打开后，这里就能给 TA 悄悄表白了。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const matched = (overview?.items ?? []).filter((item) => item.status === "matched");
  const pending = (overview?.items ?? []).filter((item) => item.status === "pending");
  const limits = overview?.limits;
  const remaining = limits && limits.dailyLimitPerUser > 0
    ? Math.max(0, limits.dailyLimitPerUser - (overview?.usedToday ?? 0))
    : null;
  const webEnabled = limits?.allowWebSubmit !== false;

  return (
    <div className="h-full overflow-y-auto px-1 pb-24 md:pb-6">
      <div className="space-y-4">
        <Card className="product-surface rounded-md border-slate-200 bg-white shadow-none">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-gradient-to-br from-rose-400 to-pink-500 text-white">
                <HeartIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold text-slate-950">青青子衿，悠悠我心</p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  写下想对 TA 说的话，对方不会收到任何提示。只有 TA 也向你表白，机器人才会同时通知你们双方，并互相公开身份与原话。
                </p>
              </div>
            </div>

            {webEnabled ? (
              <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <label className="grid gap-1 text-sm font-medium">
                  对方 QQ 号
                  <Input
                    value={toQq}
                    inputMode="numeric"
                    placeholder="例如 123456789"
                    disabled={submitting}
                    onChange={(event) => setToQq(event.target.value.replace(/\D/g, "").slice(0, 12))}
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  想说的话
                  <Textarea
                    className="min-h-24"
                    value={text}
                    maxLength={limits?.maxTextLength ?? 200}
                    placeholder="例如：每次在图书馆看到你，都会开心一整天"
                    disabled={submitting}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {text.trim().length}/{limits?.maxTextLength ?? 200} 字
                    {remaining !== null ? ` · 今天还可以表白 ${remaining} 次` : ""}
                    {limits?.aiScreenEnabled ? " · 内容会先过一遍机器审核" : ""}
                  </span>
                </label>
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-1 text-xs text-slate-500">
                    <LockIcon className="size-3.5" />
                    表白内容仅你可见，直到互相表白
                  </p>
                  <Button onClick={() => void submit()} disabled={submitting}>
                    <SendIcon className="mr-1 size-4" />
                    {submitting ? "发送中…" : "悄悄表白"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                本墙已关闭网页端表白，请给墙号机器人私聊发送：<span className="font-mono">#表白 对方QQ号 想说的话</span>
              </div>
            )}
          </CardContent>
        </Card>

        <ConfessionSection
          title="已互相表白"
          description="你们同时向对方表白了，机器人已经通知双方。"
          items={matched}
          emptyText="还没有互相表白的记录。"
          highlight
        />
        <ConfessionSection
          title="等待回应"
          description="这些表白只有你自己能看到，对方不会收到任何提示。"
          items={pending}
          emptyText="还没有发出过表白。"
        />
      </div>
    </div>
  );
}

function ConfessionSection({
  title,
  description,
  items,
  emptyText,
  highlight = false,
}: {
  title: string;
  description: string;
  items: ConfessionItem[];
  emptyText: string;
  highlight?: boolean;
}) {
  return (
    <Card className="product-surface rounded-md border-slate-200 bg-white shadow-none">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-slate-950">{title}</p>
          <Badge className="rounded-full bg-slate-100 text-slate-600 shadow-none">{items.length}</Badge>
        </div>
        <p className="text-xs text-slate-500">{description}</p>
        {items.length === 0 ? (
          <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500">{emptyText}</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className={`rounded-md border p-3 ${highlight ? "border-rose-200 bg-rose-50/60" : "border-slate-200 bg-slate-50"}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    {item.partnerDisplayName?.trim() || "TA"}（{item.partnerQqUin}）
                  </p>
                  <div className="flex items-center gap-2">
                    {highlight ? (
                      <Badge className="rounded-full bg-rose-100 text-rose-700 shadow-none">
                        <SparklesIcon className="mr-1 size-3" />已互相表白
                      </Badge>
                    ) : (
                      <Badge className="rounded-full bg-slate-200 text-slate-600 shadow-none">等待回应</Badge>
                    )}
                    <span className="text-[11px] text-slate-400">{formatTime(item.matchedAt ?? item.createdAt)}</span>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">你对 TA 说：{item.text}</p>
                {item.partnerText ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-rose-700">TA 对你说：{item.partnerText}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
