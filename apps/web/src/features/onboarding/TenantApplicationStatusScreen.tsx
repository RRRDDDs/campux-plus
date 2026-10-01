import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2Icon, ClockIcon, LogOutIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ThemeModeButton } from "@/features/theme/ThemeModeControl";
import type { AuthenticatedMe } from "@/types/app";

/**
 * 开墙申请状态页。
 *
 * 运营者注册后处于「待审核」；被拒绝时可以在这里补充信息重新提交。
 * 审核通过后本页不再出现，直接进入开墙引导（运维界面）。
 */
export function TenantApplicationStatusScreen({
  me,
  onRefresh,
  onLogout,
}: {
  me: AuthenticatedMe;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
}) {
  const application = me.tenantApplication ?? null;
  const status = application?.status ?? "pending";
  const [busy, setBusy] = useState(false);
  const [wallName, setWallName] = useState(application?.wallName ?? "");
  const [school, setSchool] = useState(application?.school ?? "");
  const [contact, setContact] = useState(application?.contact ?? "");
  const [reason, setReason] = useState(application?.reason ?? "");
  const [showForm, setShowForm] = useState(status === "rejected");

  async function resubmit() {
    if (wallName.trim().length < 2) {
      toast.error("请填写想开的校园墙名称");
      return;
    }
    if (contact.trim().length < 2) {
      toast.error("请填写联系方式（QQ / 微信 / 手机号），方便系统运维联系你");
      return;
    }
    setBusy(true);
    try {
      await api("/api/me/tenant-application", {
        method: "POST",
        body: JSON.stringify({ wallName, school, contact, reason }),
      });
      toast.success("申请已重新提交，请等待系统运维审核。");
      setShowForm(false);
      await onRefresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  const pending = status === "pending";

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-950">开墙申请</p>
          <p className="truncate text-xs text-slate-500">{me.user.displayName ?? me.user.email ?? me.user.qqUin}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeModeButton />
          <Button variant="outline" size="sm" onClick={() => void onRefresh()}>
            <RefreshCwIcon />
            <span className="hidden sm:inline">刷新状态</span>
          </Button>
          <Button variant="outline" size="sm" aria-label="退出登录" onClick={onLogout}>
            <LogOutIcon />
            <span className="hidden sm:inline">退出</span>
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <Card className="rounded-lg border-slate-200 bg-white shadow-none">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <span className={`grid size-11 shrink-0 place-items-center rounded-full ${pending ? "bg-amber-50 text-amber-600" : "bg-rose-50 text-rose-600"}`}>
                {pending ? <ClockIcon className="size-5" /> : <XCircleIcon className="size-5" />}
              </span>
              <div className="min-w-0">
                <p className="text-lg font-semibold text-slate-950">
                  {pending ? "申请审核中" : "申请未通过"}
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {pending
                    ? "你的开墙申请已经提交给系统运维，审核通过后就能创建自己的校园墙。审核期间可以先了解墙的运营方式，不用重复提交。"
                    : application?.reviewNote || "这次申请没有通过。你可以补充下面的信息后重新提交。"}
                </p>
              </div>
            </div>

            {application ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="text-xs font-semibold text-slate-500">提交的信息</p>
                <div className="mt-2 grid gap-1">
                  <p>想开的墙名：<span className="font-medium text-slate-900">{application.wallName}</span></p>
                  {application.school ? <p>学校 / 单位：{application.school}</p> : null}
                  {application.contact ? <p>联系方式：{application.contact}</p> : null}
                  {application.reason ? <p className="whitespace-pre-wrap">用途说明：{application.reason}</p> : null}
                  <p className="text-xs text-slate-500">提交时间：{formatTime(application.createdAt)}</p>
                </div>
              </div>
            ) : null}

            {pending ? (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
                需要修改申请内容或催一下进度？可以在群里/私聊联系系统运维。
              </p>
            ) : (
              <>
                <Button variant="outline" onClick={() => setShowForm((open) => !open)}>
                  {showForm ? "收起" : "补充信息并重新提交"}
                </Button>
                {showForm ? (
                  <div className="grid gap-2 rounded-md border border-slate-200 p-3">
                    <Input value={wallName} placeholder="想开的校园墙名称（必填）" onChange={(event) => setWallName(event.target.value)} />
                    <Input value={school} placeholder="学校 / 单位（选填）" onChange={(event) => setSchool(event.target.value)} />
                    <Input value={contact} placeholder="联系方式（必填：QQ / 微信 / 手机号）" onChange={(event) => setContact(event.target.value)} />
                    <Textarea
                      className="min-h-20 text-sm"
                      value={reason}
                      maxLength={300}
                      placeholder="用途说明（选填）"
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <Button disabled={busy} onClick={() => void resubmit()}>
                      {busy ? "提交中…" : "重新提交申请"}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-slate-500">
          审核通过后，重新登录或点「刷新状态」即可进入开墙引导。
        </p>
      </div>
    </main>
  );
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
