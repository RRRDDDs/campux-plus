# 与上游 Campux 的差异

基准版本：`idoknow/Campux` 提交 `4f1bfaf`（2026-09-19）

本仓库在上游基础上只做了**加法**，没有删除或改写上游既有功能的行为。
把两个新增功能的开关全部关掉，运行表现与上游一致。

---

## 一、投稿 AI 自动审核

新增文件：

- `apps/server/src/runtime/ai-review.ts` —— AI 初审核心：提示词、调用模型、解析结果、
  判定与执行、每日上限、日志落库。
- `apps/server/src/runtime/ai-review.test.ts` —— 判定解析的单元测试。

修改文件：

- `apps/server/src/runtime/ai-settings.ts` —— 租户 AI 设置新增初审相关字段与默认值。
- `apps/server/src/routes/ai.ts` —— 设置接口的字段校验。
- `apps/server/src/routes/posts.ts` —— 网页投稿创建成功后触发初审。
- `apps/server/src/runtime/onebot.ts` —— QQ 私聊投稿创建成功后触发初审。
- `apps/web/src/features/admin/AdminPage.tsx` —— 后台「LLM 设置」新增「AI 初审」面板。
- `apps/web/src/types/app.ts` —— 对应类型。
- `packages/domain/src/index.ts` —— 默认墙规文本与常量。

行为要点：

- 判定结果分 `approve` / `manual_review` / `reject`，只有「低风险 + 高置信度 + 无敏感命中」
  才会自动通过；自动通过与人工通过走同一条链路（改状态 → 写日志 → 触发发布）。
- 任何异常（超时、接口报错、返回格式错误）都保持待审核，不影响投稿本身。
- 含附件的稿件一律转人工（不判断图片内容）。
- 默认关闭，需管理员在后台开启。

## 二、青青子衿 · 双向表白

新增文件：

- `packages/db/prisma/migrations/20260924200000_add_confessions/migration.sql` —— 新增 `Confession` 表。
- `apps/server/src/lib/confession.ts` —— 校验、限额、落库、互相匹配、通知、AI 过滤。
- `apps/server/src/lib/confession.test.ts`、`confession-command.test.ts` —— 单元测试。
- `apps/server/src/routes/confessions.ts` —— 用户接口与管理端记录接口。
- `apps/web/src/features/confession/ConfessionsPage.tsx` —— 网页端「表白」标签页。

修改文件：

- `packages/db/prisma/schema.prisma` —— 新增 `Confession` 模型与关系。
- `packages/domain/src/index.ts` —— 表白字数与次数常量。
- `apps/server/src/lib/tenant-plugin-config.ts`、`lib/preset-plugins.ts` —— 新增预设插件与配置段。
- `apps/server/src/lib/bot-messages.ts` —— 帮助文案新增表白命令说明。
- `apps/server/src/runtime/onebot.ts` —— 私聊入口接管 `#表白` 命令。
- `apps/server/src/routes/metadata.ts` —— 下发表白入口开关。
- `apps/server/src/index.ts` —— 注册表白路由。
- `apps/web/...`（`App.tsx`、`lib/app-model.ts`、`shell/AppShell.tsx`、`admin/PluginConfigPage.tsx`、`types/app.ts`）—— 导航入口、页面挂载、插件配置面板与记录列表。

行为要点：

- 单方表白不通知对方（不显示条数、无任何提示）；双方互相表白后同时私聊通知双方并互相公开身份与原话。
- 只能向本墙已注册用户表白，不能向自己表白，被封禁账号不能发也不能收。
- 每人每天次数、单条字数、是否过 AI 过滤、是否允许网页发起均可后台配置。
- 管理员可在插件配置页查看全部表白记录（含未匹配的），普通用户与审核员不可见。

## 三、仓库层面的调整

## 三、开墙申请审核 + 系统运维删墙

新增文件：

- `packages/db/prisma/migrations/20261001030000_add_tenant_applications/migration.sql` —— 新增 `TenantApplication` 表。
- `apps/server/src/lib/tenant-application.ts` —— 申请提交/重新提交、审核、开墙资格判定（系统运维不限；其他人需申请通过且尚无墙）。
- `apps/server/src/lib/tenant-application.test.ts` —— 状态归一化与摘要转换的单元测试。
- `apps/server/src/lib/tenant-export.ts` —— 删除前导出该校园墙的完整数据（BigInt/日期已做 JSON 安全转换）。
- `apps/web/src/features/onboarding/TenantApplicationStatusScreen.tsx` —— 申请审核中 / 被拒绝（可重新提交）页面。

修改文件：

- `packages/db/prisma/schema.prisma` —— 新增 `TenantApplication` 模型与用户关系。
- `apps/server/src/routes/auth.ts` —— 注册即提交开墙申请；`GET /api/me` 返回申请状态与开墙资格；新增 `POST /api/me/tenant-application`（重新提交）。
- `apps/server/src/routes/system.ts` —— 创建校园墙前强制校验开墙资格；新增开墙申请列表/审核接口；新增导出与彻底删除接口。
- `apps/web/src/App.tsx` —— 待审核/被拒时进入申请状态页；单墙模式下为系统运维保留运维入口。
- `apps/web/src/features/auth/LoginScreen.tsx` —— 注册表单改为「申请开墙」并收集墙名/学校/联系方式/用途。
- `apps/web/src/features/ops/OpsPanel.tsx`、`overview-tenant-navigation.ts` —— 新增「开墙申请」页签与「彻底删除校园墙」危险区。
- `apps/web/src/types/app.ts` —— 对应类型。

行为要点：

- 申请未通过时，创建校园墙接口返回 403（后端强制，不依赖前端隐藏按钮）。
- 只有 `system_operator` 能查看/审核申请、导出与删除校园墙；运营管理员访问一律 403。
- 每个账号默认只能开 1 个校园墙（判定方式：当前没有任何以 admin 身份参与的墙）；历史账号不受影响，但同样无法再开第二个。
- 删除校园墙要求「先下载备份 → 勾选确认 → 输入墙名完全一致」，删除数据库数据与对象存储附件，并在审计日志写入 `tenant.delete`（保留墙名、标识与附件数量）。

## 四、账号治理：停用 / 删除账号 + 注册人机验证

新增文件：

- `packages/db/prisma/migrations/20261001150000_add_user_disable/migration.sql` —— `User` 增加 `disabledAt` / `disabledReason`。
- `apps/server/src/lib/rate-limit.ts` —— 进程内限流 + 客户端 IP 解析（优先 `cf-connecting-ip`）。
- `apps/server/src/lib/turnstile.ts` —— Cloudflare Turnstile 服务端校验（网络异常时放行，不挡正常用户）。
- `apps/web/src/features/auth/TurnstileWidget.tsx` —— 注册表单的人机验证控件（未配置 site key 时不渲染）。

修改文件：

- `packages/config/src/index.ts` —— 新增 `CAMPUX_TURNSTILE_SITE_KEY` / `CAMPUX_TURNSTILE_SECRET_KEY` 与 `config.turnstile`。
- `apps/server/src/routes/auth.ts` —— 注册去掉邮箱验证码；启用 Turnstile 后校验 token；同一来源每小时最多 5 次注册；
  登录时拒绝已停用账号；`/api/auth/context` 下发 Turnstile site key；注册返回里带上申请状态。
- `apps/server/src/lib/auth.ts` —— 会话校验发现账号被停用时，视为未登录并清空该账号会话。
- `apps/server/src/routes/system.ts` —— 新增停用/恢复、账号关联预览、按选项删除账号三个接口。
- `apps/server/src/runtime/onebot.ts` —— 被停用账号的私聊消息静默忽略。
- 前端：`App.tsx`（认证后以 `/api/me` 为准、待审核判断提前）、`LoginScreen.tsx`（去掉验证码、接入 Turnstile）、
  `OpsPanel.tsx`（停用/恢复、删除账号对话框与关联预览）、`types/app.ts`。

行为要点：

- 停用账号：立即踢下线、禁止登录、机器人侧忽略；数据保留、可恢复；不能停用系统运维账号或自己。
- 删除账号：先展示关联情况，再由操作者决定「稿件一起删 / 保留转交」与「校园墙移交 / 一起删除」，
  最后输入邮箱或昵称确认；不能删除系统运维账号或自己。
- 注册：不再需要邮箱验证码；人机验证未配置时自动降级，仅保留限流。

## 五、仓库层面的调整

- 重写 `README.md` 为二次开发版本，`DEPLOY.md` 为新写的部署教程，新增 `NOTICE`（Apache-2.0 要求的修改声明）与本文件。
- 移除 `.github/workflows`、`.github/actions`（上游面向官方镜像/发布流程，放到个人仓库只会产生失败任务）。

## 六、上游本体改动说明

上游在同一时期仍在持续更新（本仓库基线之后上游又有新提交）。若你希望跟进上游，
可以参考 `NOTICE` 里列出的文件清单，把本仓库的改动以补丁形式合并到最新上游代码上。
