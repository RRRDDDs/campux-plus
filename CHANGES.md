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

- 重写 `README.md` 为二次开发版本，`DEPLOY.md` 为新写的部署教程，新增 `NOTICE`（Apache-2.0 要求的修改声明）与本文件。
- 移除 `.github/workflows`、`.github/actions`（上游面向官方镜像/发布流程，放到个人仓库只会产生失败任务）。

## 四、上游本体改动说明

上游在同一时期仍在持续更新（本仓库基线之后上游又有新提交）。若你希望跟进上游，
可以参考 `NOTICE` 里列出的文件清单，把本仓库的改动以补丁形式合并到最新上游代码上。
