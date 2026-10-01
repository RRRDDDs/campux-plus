# 部署教程：从一台空服务器到能收投稿的校园墙

本文以 **Ubuntu 22.04 / 24.04 + Docker Compose** 为主线（推荐方式），文末给出单文件二进制方式。
所有命令都可以直接复制执行，把 `<服务器IP>`、`example.com` 之类占位符换成你自己的即可。

---

## 0. 先理解要部署什么

```
  学生浏览器 ─┐
              ├─► nginx (443, HTTPS) ─► Campux 应用 (8989) ─┬─► PostgreSQL (数据)
  QQ 私聊 ────┘                            ▲                └─► MinIO/S3 (图片附件)
     │                                     │
     └── NapCat / LLOneBot ── 反向 WebSocket ──┘
         （运行在能稳定登录 QQ 的机器上，比如自己的电脑或 NAS）

  Campux 应用 ── 出站 HTTPS ──► DeepSeek API（AI 审核 / 表白内容过滤）
  Campux 应用 ── 出站 HTTPS ──► QQ 空间（发表说说、拉取评论）
```

几个关键点，先说了能省掉很多坑：

- **QQ 机器人（NapCat / LLOneBot）建议部署在家庭宽带或 NAS 上**，cloud 服务器 IP 登录 QQ 容易被风控。
  Campux 通过「反向 WebSocket」接收机器人消息：是机器人主动连 Campux，所以机器人可以在任何能上网的地方。
- **端口千万不要全开到公网**：只需要 22（SSH）、80/443（网页）。`8989`、`5432`、`9000/9001` 一律不要暴露，
  否则 PostgreSQL 和 MinIO 会变成裸奔的服务。
- **AI 相关功能都可以不启用**：不填 API Key 照样能跑，只是没有 AI 自动审核、表白内容过滤。

### 端口一览

| 端口 | 服务 | 是否需要公网 |
| --- | --- | --- |
| 8989 | Campux 应用（Web + API + OneBot 入口） | 只用 IP 访问时需要；用 nginx 反代时不需要 |
| 5432 | PostgreSQL | ❌ 绝对不要 |
| 9000 / 9001 | MinIO 对象存储（图片） | ❌ 不要（要 CDN 时单独配置） |
| 80 / 443 | nginx（推荐） | ✅ 需要 |

### 三种部署方式

| 方式 | 特点 | 适合 |
| --- | --- | --- |
| **Docker Compose** | 一条命令拉起应用 + PostgreSQL + MinIO，升级简单 | 生产环境（本文主线） |
| 单文件可执行 | 内嵌 SQLite + 本地文件存储，零依赖 | 单墙自用、不想维护数据库 |
| 本地开发 | 只起基础设施，前后端热更新 | 二次开发 |

---

## 1. 准备工作

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 服务器 | **2 核 2G 起**，Ubuntu 22.04/24.04，磁盘 20G+ | 1 核 1G 编译镜像会卡在内存上，需要加 4G swap（见 2.4） |
| 域名（可选） | 任意域名 | 有域名才能上 HTTPS；只用 IP 也能跑 |
| QQ 机器人 | NapCat（推荐）或 LLOneBot | 用一个**专门的 QQ 号**当墙号，不要用主号 |
| DeepSeek API Key（可选） | platform.deepseek.com 申请，充 10 元能用很久 | 用于 AI 自动审核与表白内容过滤 |
| 安全组/防火墙 | 只放行 22、80、443 | 云厂商控制台里配置 |

---

## 2. Docker Compose 部署（推荐）

### 2.1 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker   # 免 sudo 使用 docker
docker compose version                            # 确认 compose 插件可用
```

### 2.2 获取代码

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git campux
cd campux
```

### 2.3 配置 .env

```bash
cp .env.example .env
# 生产必填：用于加密存储机器人的登录态，缺失容器会拒绝启动
echo "CAMPUX_BOT_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
```

最小可用配置说明（直接写进 `.env`）：

```ini
# 对外访问地址：用域名就写 https://example.com，只用 IP 就写 http://<服务器IP>:8989
CAMPUX_WEB_ORIGIN="http://<服务器IP>:8989"
# 数据库（compose 内部网络，默认即可）
DATABASE_URL="postgresql://campux:campux@postgres:5432/campux_next"
# 机器人的登录态加密密钥，必填，用上面的 openssl 命令生成
CAMPUX_BOT_SESSION_SECRET="<32字节随机串>"
# 按要求可关闭匿名遥测（默认会每 2 小时上报匿名聚合计数，不含内容与身份）
CAMPUX_TELEMETRY_DISABLED="true"
```

其它可选变量：

| 变量 | 用途 |
| --- | --- |
| `CAMPUX_WEB_ORIGIN` | 前端跨域来源，用域名+HTTPS 时必须与访问地址一致 |
| `CAMPUX_SKIP_AUTO_MIGRATE` | 设为 `true` 跳过启动时自动数据库迁移（默认自动迁移） |
| `S3_*` | 图片存储。默认用 compose 里的 MinIO；也可以换成自己的 S3/OSS |
| `S3_PUBLIC_BASE_URL` | 图片对外访问前缀，用域名时建议改成 `https://example.com/s3/...` 之类 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 容器内 Chromium 路径，用于渲染说说配图（compose 已默认配置） |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | 配置后管理员注册验证码走邮件；不配则验证码直接显示在接口响应里（自用更方便） |
| `CAMPUX_TENANT_DOMAIN_*` / `CAMPUX_CLOUDFLARE_*` | 多租户自动分配子域名（自助开墙）时才需要 |

### 2.4 构建与启动

```bash
docker compose up -d --build
```

首次会编译前端（Vite）与后端（TypeScript），**2 核 2G 约 5-10 分钟**。

> **1 核 1G 的服务器**：编译阶段内存不足会失败或极慢，先加 swap：
> ```bash
> sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
> ```
> 这是实测结论：1C1G + 4G swap 能编过（20 分钟以上），2C2G 快很多。

验证是否起来：

```bash
docker compose ps                     # campux 应该是 Up (healthy)
curl -s http://127.0.0.1:8989/api/health
# {"ok":true,"service":"campux-next","queue":{...}}
docker compose logs -f --tail=50 campux     # 看启动日志（含自动数据库迁移结果）
```

启动日志里能看到 `database migrations completed` 与 `Server listening at ...` 即表示正常。

### 2.5 首次初始化

浏览器打开 `http://<服务器IP>:8989`，进入初始化向导：

1. 选择部署模式：**自用单墙**（隐藏多租户界面）或 **多租户运营平台**（多个墙主自助开墙）。
2. 创建第一个管理员账号（邮箱 + 密码）。没配邮件服务时验证码会直接显示。
3. 按向导提示进入「接入机器人」这一步，先别急着关页面。

### 2.6 反向代理 + HTTPS（推荐）

只用 IP 访问可以跳过本节，但 HTTPS 是刚需（QQ 空间相关功能和浏览器的安全策略都更友好）。

安装 nginx 与证书：

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

新建 `/etc/nginx/sites-available/campux`：

```nginx
server {
    server_name example.com;           # 改成你的域名

    location / {
        proxy_pass http://127.0.0.1:8989;
        proxy_http_version 1.1;
        # 下面四行是 WebSocket（QQ 机器人）必需的
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 图片上传/长请求，超时给足
        client_max_body_size 600m;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

启用并申请证书：

```bash
sudo ln -s /etc/nginx/sites-available/campux /etc/nginx/sites-enabled/campux
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com        # 自动改写成 443 + 自动续期
```

然后把 `.env` 里的 `CAMPUX_WEB_ORIGIN` 改成 `https://example.com`，重启生效：

```bash
docker compose up -d --no-deps campux
```

> 只用 IP + 端口的部署，安全组要放行 8989；用域名 + nginx 的部署，**建议只放行 80/443，把 8989 关掉**。

### 2.7 接入 QQ 机器人（NapCat 反向 WebSocket）

1. 在服务器上 Campux 后台 → **管理 → 机器人**，添加一个墙号（填机器人 QQ 号），
   页面会给出形如下面的 OneBot 地址（含该墙号专属 token）：

   ```
   ws://<服务器IP>:8989/onebot/v11/ws?bot_id=<bot-id>&token=<token>
   ```

   用了域名 + HTTPS 就是：

   ```
   wss://example.com/onebot/v11/ws?bot_id=<bot-id>&token=<token>
   ```

2. 在 NapCat（部署在家庭宽带/NAS 上）里：**网络配置 → 新建「WebSocket 客户端」（反向 WS）**，
   把上面整条地址粘进去，开启该连接。
3. 回到 Campux 日志查看是否连上：

   ```bash
   docker compose logs --tail=50 campux | grep -i onebot
   # onebot websocket connected  ← 出现这行即成功
   ```
4. 用手机 QQ 给墙号发一条 `#注册账号` 或随便一句话，能收到自动回复就说明链路通了。
5. 在后台配置 **审核群**（机器人进群后填群号），之后新投稿会通知到群里，
   可用 `#通过 1234` / `#拒绝 理由 1234` 在群里处理。

> 机器人 QQ 掉线时，投稿、审核都不会丢，只是收不到实时消息；重连后会自动恢复。

### 2.8 配置发布目标（发到 QQ 空间）

后台 → **管理 → 发布目标 / 机器人**：配置要发布到的 QQ 空间、发布间隔、是否需要扫码登录获取 cookies。
Cookies 失效时后台会告警，重新扫码即可。发布失败可在「发布」页看到失败原因并重试。

### 2.9 Cloudflare 橙云（可选）

想让网站更抗打，可以在 Cloudflare 把域名解析打开橙云（代理）。注意三件事：

1. **WebSocket 会走 CF，需要保持 `wss://`（443）**。如果写成 `ws://域名/...`（80 端口），
   CF/nginx 会返回 301 跳转，而 WebSocket 客户端不跟随重定向，机器人就连不上。
2. **CF 会切断空闲超过约 100 秒的 WebSocket**。在 NapCat 里开启心跳（建议 ≤30 秒）并打开断线重连；
   否则会看到每 100 秒重连一次。
3. **不要开 Bot Fight Mode / Under Attack 模式**，它们会给非浏览器请求返回 JS 挑战页，WebSocket 握手直接失败。
   需要 WAF 的话，给 `/onebot/` 路径加一条 Skip 规则。SSL/TLS 模式选 **Full (strict)**。

另外提醒：**开了橙云不等于安全**。如果源站 IP 仍能直接访问 80/443，攻击者查到源站 IP 就能绕过 CF。
更彻底的做法是把安全组的 80/443 只放行 Cloudflare 官方 IP 段（注意：这样 certbot 的 HTTP-01 续期会失败，
需要改用 DNS 验证，或续期时临时放行）。

---

## 3. 单文件二进制部署（可选）

适合「一台小机器 + 单面墙 + 不想维护数据库」的场景，内嵌 SQLite + 本地文件存储。

本仓库的改动同样可以用 Bun 编译成单文件：

```bash
# 需要 Bun（https://bun.sh），原生依赖无法跨平台交叉编译，必须在目标平台构建
curl -fsSL https://bun.sh/install | bash
bun install
bun run build:binary        # 产物在 release/ 目录
./release/campux-linux-x64  # 默认在 ./data 建 SQLite 库与本地存储，监听 8989
```

配置方式与 Docker 版一致（环境变量），但数据库为 SQLite，图片存在本地目录。
需要更强的并发或独立备份时，只要提供 `DATABASE_URL=postgresql://...` 就会自动切到 PostgreSQL。

> 注意：上游也提供官方 Release 二进制，但那是**未包含本项目新增功能**的原版；
> 要用 AI 审核和表白功能，请从本仓库自行构建。

---

## 4. 两个新增功能的配置

### 4.1 AI 自动审核

1. 准备 Key：注册 platform.deepseek.com → 充值（10 元够很久）→ 创建 API Key。
2. 后台 → **管理 → 元数据 → LLM 设置**：

   | 字段 | 填什么 |
   | --- | --- |
   | baseUrl | `https://api.deepseek.com` |
   | model | `deepseek-flash`（推荐）或 `deepseek-v4-pro` |
   | API Key | 你的 Key（加密存储，不会明文回显） |
   | 模式 | 选 `llm` |

   填完点「测试连接」，出现类似「LLM 配置可用」即成功。

3. 展开 **「AI 初审」**：

   | 设置 | 建议 |
   | --- | --- |
   | AI 初审总开关 | 打开 |
   | 低风险自动通过 | 打开（这是省人力的主力） |
   | 明确违规自动拒绝 | 打开（广告、涉政、恶意攻击等直接拒） |
   | 通过置信度 | 0.9（越高越保守） |
   | 拒绝置信度 | 0.85 |
   | 每日自动通过上限 | 200（防止异常情况批量误放） |
   | 初审墙规 | 改成你自己学校的口径 |

4. 验证：随便投一条正常内容（例如"今天食堂的糖醋里脊好好吃"），
   几秒内稿件状态应该变成已通过并进入发布；再投一条明显违规的看是否被拒。
   也可以直接看日志：

   ```bash
   docker compose logs --tail=50 campux | grep "ai review"
   # ai review: post auto approved / auto rejected
   ```

5. 成本参考（DeepSeek flash，关闭思考模式）：单条约 1 秒、约 ￥0.0013，
   100 条/天约 ￥4/月。低谷时段（非工作日上午 9-12 点、下午 2-6 点，以及周末和法定节假日）价格减半。

**排错**：如果 AI 不生效，依次检查 —— ① LLM 设置里模式是否为 `llm`、是否有 Key；
② 「AI 初审」总开关是否打开；③ 稿件是否含图片（含图片一律转人工）；
④ 日志里 `ai review` 的报错（401 表示 Key 无效、超时表示网络或模型不可达）。
任何异常都会自动退回人工审核，不会丢稿件。

### 4.2 青青子衿（双向表白）

1. 后台 → **管理 → 插件配置 → 「青青子衿，悠悠我心」** → 打开开关。
2. 「配置」页可调：

   | 设置 | 说明 |
   | --- | --- |
   | AI 内容过滤 | 表白正文先过大模型，广告/涉政/辱骂/联系方式等不投递（复用上面的 LLM 设置） |
   | 允许网页端发起 | 关闭后只能用机器人私聊表白 |
   | 每人每天次数 | 默认 3，0 表示不限 |
   | 单条字数上限 | 默认 200 |

3. 用户怎么用：
   - 机器人私聊：`#表白 对方QQ号 想说的话`
     （也支持 `#表白：123456789 内容`、全角 `＃`、多行内容）
   - 网页端：底部导航出现「表白」标签页，填写对方 QQ 号与内容。
4. 效果：单方表白只回复发送者「已经悄悄记下了」，对方无任何提示；
   对方也表白后，机器人同时私聊通知双方并互相转达原话，网页端出现「已互相表白」记录。
5. 管理员可在插件配置页下方查看全部表白记录（含未匹配的）用于风控。

### 4.3 开墙申请审核与删墙（多租户运营）

适用于「把校园墙当平台运营、需要控制谁能开墙」的场景。

**申请人流程**

1. 访问管理入口（登录页）→ 点「申请开墙」→ 填邮箱验证码、账号密码，以及想开的墙名（必填）、学校/单位、联系方式、用途说明。
2. 提交后账号立即创建，但停在「申请审核中」页面：进不去开墙向导，直接调接口建墙也会被服务端拒绝。
3. 审核通过后刷新状态即可创建自己的校园墙；被拒绝会看到理由并可以补充信息重新提交。

**系统运维流程**

1. 登录 → 右上角头像 → 进入「运维面板」（单墙模式下该入口只对系统运维/运营管理员可见）。
2. 左侧「开墙申请」页签：导航上会显示待审核数量；可筛选待审核/已通过/已拒绝；通过或拒绝（拒绝可写理由，理由会展示给申请人）。
3. 删除校园墙：切到「校园墙」页签 → 选中目标墙 → 详情底部红框「彻底删除校园墙」→ 先下载 JSON 备份 → 勾选确认 → 输入墙名完全一致 → 删除。

> 删除会清空该墙的稿件、成员关系、机器人配置、表白记录与对象存储中的图片，且不可恢复；
> 平台审计日志会保留一条 `tenant.delete` 记录。重要校园墙删除前，建议先做整库备份（见第 5 节）。

**配额**：默认每个账号只能开 1 个校园墙。如果需要放开为多个或不限，修改
`apps/server/src/lib/tenant-application.ts` 里 `resolveTenantCreationPermission` 的配额判断即可
（改成从租户/系统设置里读取额度也很容易）。

### 4.4 注册人机验证与账号治理

**注册人机验证（Cloudflare Turnstile，可选但推荐）**

1. 在 Cloudflare 后台 → **Turnstile** → 添加站点，域名填你的墙域名（例如 `example.com`），
   拿到 **Site Key** 与 **Secret Key**。
2. 写入 `.env` 并让 compose 透传（compose 已包含这两个变量）：

   ```ini
   CAMPUX_TURNSTILE_SITE_KEY="你的-site-key"
   CAMPUX_TURNSTILE_SECRET_KEY="你的-secret-key"
   ```

3. `docker compose up -d --no-deps campux` 重启后生效：注册表单会出现（通常无感的）人机验证，
   服务端会向 Cloudflare 校验 token。**两个 key 都配置才生效**，未配置时自动降级为仅限流。

无论是否启用人机验证，注册接口都有限流：同一来源每小时最多 5 次提交（返回 429）。
来源 IP 优先取 Cloudflare 的 `cf-connecting-ip`。

**账号治理（运维面板 → 全局用户）**

- **停用 / 恢复账号**：停用后立即踢下线、禁止登录（对方会看到停用原因），QQ 机器人侧也会忽略其消息；
  数据保留、随时恢复。系统运维账号与自己不能被停用。
- **删除账号**：先看到该账号的关联情况（稿件、竞选、墙内身份、开墙申请、表白记录），再选择：
  - 稿件与竞选：一起删除（含图片）／保留并转交「已注销账号」；
  - 他运营的校园墙：保留并移交给你／连同校园墙一起彻底删除；
  - 输入该账号的邮箱或昵称确认后执行。

> 删除不可恢复；平台审计日志会保留 `system.user.delete` 记录（含删除的校园墙与稿件数量）。

---

## 5. 日常运维

### 备份（动手改任何东西之前先做）

```bash
TS=$(date +%Y%m%d-%H%M%S); BK=/root/campux-backups/$TS; sudo mkdir -p "$BK"

# 1) 数据库
sudo docker exec campux-postgres pg_dump -U campux -d campux_next | gzip | sudo tee "$BK/campux_next.sql.gz" >/dev/null
# 2) 源码与配置（.env 里有密钥，注意别外传）
sudo tar -czf "$BK/campux-source-and-env.tar.gz" -C /root --exclude=Campux/.git --exclude=Campux/node_modules Campux
# 3) 镜像打回滚标签（回滚时把 local 指回去即可）
sudo docker tag rockchin/campux:local "rockchin/campux:good-$TS"
```

### 升级

```bash
cd campux
sudo git diff > /root/campux-backups/我的改动.patch   # 有本地改动先导出，避免被覆盖
git pull
docker compose up -d --build
docker compose logs --tail=50 campux | grep -i migration   # 确认迁移执行成功
```

### 回滚

```bash
cd campux && git checkout -- .        # 撤掉代码改动
docker tag rockchin/campux:good-<时间戳> rockchin/campux:local
docker compose up -d --no-deps --force-recreate campux
```

数据库迁移是增量且向后兼容的（只新增表/列），回滚代码不需要回滚数据库。

---

## 6. 排错手册

| 现象 | 排查方向 |
| --- | --- |
| 容器起不来，日志提示缺少 secret | `.env` 里 `CAMPUX_BOT_SESSION_SECRET` 没设，用 `openssl rand -hex 32` 生成 |
| 打不开网页 | 安全组是否放行端口；`curl http://127.0.0.1:8989/api/health` 是否返回 ok |
| 机器人连不上 | OneBot 地址是否与后台一致（含 token）；用了域名是否写成 `wss://`；CF 是否开了 Bot Fight Mode；服务器 8989/443 是否可达 |
| 机器人反复掉线 | 心跳间隔太长（CF 约 100 秒空闲会断开）；或服务器/家庭网络不稳定 |
| 新投稿没有 AI 判定 | 见 4.1 排错；确认日志出现 `ai review` 关键字 |
| 表白入口看不到 | 插件开关是否打开；刷新页面（入口按插件状态显隐） |
| 图片上传失败 | MinIO 是否健康（`docker compose ps`）；`S3_PUBLIC_BASE_URL` 是否指向可访问地址 |
| 编译失败 / 卡住 | 内存不足，加 swap（见 2.4）；确认磁盘剩余 > 10G |
| 发布到 QQ 空间失败 | cookies 失效，后台重新扫码登录；看「发布」页的失败原因 |

---

## 7. 安全清单

- 安全组只放行 22 / 80 / 443；`5432`、`9000`、`9001`、`8989` 不要对公网开放。
- PostgreSQL 与 MinIO 的默认密码（`campux` / `campux-secret`）**务必修改**，或者保证端口不对外。
- `CAMPUX_BOT_SESSION_SECRET` 是加密密钥，泄露等于机器人登录态泄露；换服务器时随 `.env` 一起迁移。
- 管理员账号开启强密码；只把「管理员」角色给可信的人（审核员看不到 AI 设置与插件配置）。
- DeepSeek Key 建议定期轮换（后台重新填写即可）。
- 匿名遥测如不需要，设 `CAMPUX_TELEMETRY_DISABLED=true`。
- 定期备份数据库；备份文件里包含用户数据与密钥，不要放进公开仓库。
