# 跑团软件部署说明

本文只写通用部署步骤，不记录服务器密码、API 密钥或 TURN 密码。

## 服务器要求

- Ubuntu 24.04 LTS
- 8 核 / 8G / 40G 盘 / 100Mbps 可支撑 10 人内内测
- 域名建议准备两个：应用域名 `APP_DOMAIN`，语音域名 `VOICE_DOMAIN`

## 需要开放端口

```text
80/tcp
443/tcp
443/udp
7881/tcp
3478/udp
50000-50100/udp
49160-49200/udp
```

`7880/tcp` 是 LiveKit HTTP/WebSocket/API 端口，只在 Docker 网络内给 Caddy 和后端访问；默认不要直接对公网开放。客户端语音入口使用 `wss://VOICE_DOMAIN`，由 Caddy 通过 443 反代到 `livekit:7880`。

## 部署步骤

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
```

上传或拉取项目到服务器：

```bash
sudo mkdir -p /opt/paotuan
sudo chown -R "$USER":"$USER" /opt/paotuan
cd /opt/paotuan
```

准备环境变量：

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

`deploy/.env` 请保存为 UTF-8 无 BOM，避免远端 shell 读取首行时把 BOM 当成内容。

至少修改：

```text
APP_DOMAIN=你的应用域名
VOICE_DOMAIN=你的语音域名
ACME_EMAIL=你的邮箱
PUBLIC_IP=203.0.113.10
LIVEKIT_URL=wss://你的语音域名
LIVEKIT_API_URL=http://livekit:7880
LIVEKIT_API_KEY=随机生成
LIVEKIT_API_SECRET=随机生成
VERIFICATION_CODE_SECRET=随机生成

EMAIL_DELIVERY_MODE=resend
RESEND_API_KEY=Resend API Key
RESEND_FROM=no-reply@example.com
RESEND_FROM_NAME=夜航跑团桌

CLOUD_MAIL_BASE_URL=https://mail.example.com
CLOUD_MAIL_EMAIL=发信账号@example.com
CLOUD_MAIL_PASSWORD=replace-with-cloud-mail-password
CLOUD_MAIL_TOKEN=
CLOUD_MAIL_ACCOUNT_ID=
CLOUD_MAIL_FROM=
CLOUD_MAIL_FROM_NAME=夜航跑团桌
CLOUD_MAIL_TIMEOUT_MS=10000

SMTP_HOST=你的 SMTP 主机
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@你的域名
SMTP_PASS=replace-with-smtp-password
SMTP_FROM=no-reply@你的域名
EMAIL_FROM_NAME=夜航跑团桌
SMTP_TIMEOUT_MS=10000
PAOTUAN_DISABLE_DATA_DIR_LOCK=false
```

当前后端使用单进程内存状态加 `DATA_DIR/state.json` 持久化，`server` 服务不要横向扩容或设置多个副本。后端启动时会创建 `DATA_DIR/server.lock`，同一数据目录已有存活进程时会拒绝启动，防止两个进程互相覆盖 JSON 状态；生产环境不要关闭 `PAOTUAN_DISABLE_DATA_DIR_LOCK`。

邮箱验证码的外发通道可用 `EMAIL_DELIVERY_MODE=resend|smtp|cloud-mail|console` 显式指定。QQ、Gmail、Outlook 等外部邮箱必须走 Resend 或可靠 SMTP 中继；未开启 Resend 的 Cloud Mail 只能给站内邮箱发件。未显式指定时优先级是 Resend > Cloud Mail > SMTP > 本地开发 console。`EMAIL_DELIVERY_MODE=console` 是调试开关，设置后会强制走控制台发信并返回 `debugCode`，生产环境不要保留。

如果暂时没有域名，只做 IP 内测：

```bash
cp deploy/.env.http.example deploy/.env
nano deploy/.env
```

IP 内测只能验证 Web、API、账号、房间、地图、聊天和 token 签发。浏览器麦克风通常要求 HTTPS，所以高清语音正式可用仍需要域名和 HTTPS。

启动：

```bash
cd /opt/paotuan/deploy
docker compose --env-file .env up -d --build
docker compose ps
```

也可以从 Windows 本地执行远程部署脚本。脚本会打包当前项目、上传到服务器、安装 Docker（如果缺失）、运行 `docker compose config` 和 `up -d --build`。脚本不会接收或保存服务器密码；SSH 认证交给系统的 `ssh/scp`。

```powershell
npm run deploy:remote -- -HostName 203.0.113.10 -User root -EnvFile H:\path\to\paotuan.env
```

没有域名时使用 HTTP 内测模式：

```powershell
npm run deploy:remote -- -HostName 203.0.113.10 -User root -EnvFile H:\path\to\paotuan-http.env -HttpOnly
```

`paotuan.env` 内容使用 `deploy/.env.example` 的格式，并保存为 UTF-8 无 BOM。不要把真实 env 文件提交到仓库。

如果只是更新前端静态资源，先在本地确认 `npm run build` 通过，然后可以只覆盖 web 容器里的 `apps/web/dist`，避免重新拉 Docker 基础镜像：

```powershell
npm run deploy:web-dist -- -HostName 203.0.113.10 -User root -SkipBuild
```

## 验证

```bash
curl -f https://你的应用域名/health
curl -f https://你的应用域名/site.webmanifest
docker compose logs --tail=100 server
docker compose logs --tail=100 livekit
```

`/health` 只返回基础存活状态，不再公开邮件与 LiveKit 细节。邮件通道细节通过登录后的 `/api/health/details` 查看；Resend 生产配置应看到 `provider=resend` 且 `resendConfigured=true`，Cloud Mail 生产配置应看到 `provider=cloud-mail` 且 `cloudMailVerified=true`，SMTP 配置应看到 `provider=smtp` 且 `smtpVerified=true`。只有 `emailDeliveryEnabled=true` 还不够，那只代表配置被读取到了。LiveKit 生产配置应看到 `livekit.enabled=true` 且 `livekit.adminConfigured=true`；发布前可用 `SMOKE_CHECK_LIVEKIT_ADMIN=true npm run smoke` 强制验证 RoomService 管理接口可达。

在服务器上也可以运行：

```bash
DEPLOY_DIR=/opt/paotuan/current/deploy sh /opt/paotuan/current/scripts/server-verify.sh
```

HTTP 内测模式：

```bash
DEPLOY_DIR=/opt/paotuan/current/deploy COMPOSE_FILES="-f docker-compose.yml -f docker-compose.http.yml" VERIFY_PUBLIC_HTTP=1 sh /opt/paotuan/current/scripts/server-verify.sh
```

也可以从本机对服务器做完整 smoke 检查：

```bash
SMOKE_BACKEND_URL=https://你的应用域名 SMOKE_FRONTEND_URL=https://你的应用域名 npm run smoke
```

验证真实 Cloud Mail 发信时，让 smoke 使用一个可被 Cloud Mail 管理员读取的测试邮箱域名：

```bash
SMOKE_REQUIRE_CLOUD_MAIL=true \
SMOKE_EMAIL_DOMAIN=example.com \
SMOKE_CLOUD_MAIL_BASE_URL=https://mail.example.com \
SMOKE_CLOUD_MAIL_EMAIL=管理员邮箱 \
SMOKE_CLOUD_MAIL_PASSWORD=管理员密码 \
SMOKE_BACKEND_URL=https://你的应用域名 \
SMOKE_FRONTEND_URL=https://你的应用域名 \
npm run smoke
```

远端 UI 截图和移动端底部导航遮挡检查：

```bash
UI_CHECK_FRONTEND_URL=https://你的应用域名 \
UI_CHECK_API_BASE=https://你的应用域名 \
UI_CHECK_EMAIL_DOMAIN=example.com \
UI_CHECK_CLOUD_MAIL_BASE_URL=https://mail.example.com \
UI_CHECK_CLOUD_MAIL_EMAIL=管理员邮箱 \
UI_CHECK_CLOUD_MAIL_PASSWORD=管理员密码 \
UI_CHECK_SCREENSHOT_PREFIX=remote \
npm run ui:remote
```

开发/联调时可以把 `EMAIL_DELIVERY_MODE=console` 和 `EMAIL_DEBUG_CODE=1` 打开，`/api/auth/verification-code` 会返回 `debugCode` 方便自动化验证。生产环境不要保留这个开关。

浏览器打开 `https://你的应用域名`，点击“加入语音”。如果没有配置 LiveKit，界面会显示演示状态；配置完成后会通过 `wss://你的语音域名` 连接 WebRTC 语音。

默认使用 LiveKit 内置 TURN/UDP，端口是 `3478/udp`，不需要单独维护 coturn 用户名和密码。后续如果要把语音拆到独立服务器，再考虑独立 TURN 服务。

账号、房间、聊天、角色和棋子状态会写入 Docker 卷 `server_data`。升级容器时不要删除这个卷。

## 10 人内语音建议

- 优先保证 UDP `50000-50100` 可达，10 人内内测足够；大量并发房间再扩大端口段或拆独立语音服务器。
- 服务器地区应靠近玩家，语音延迟比 CPU 配置更敏感。
- 40G 盘不要长期存大附件、录音和地图原图；后续应接对象存储。
