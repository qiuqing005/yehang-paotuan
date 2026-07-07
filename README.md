# 夜航跑团桌

Android / Windows 互通跑团软件 MVP。当前实现为 Web/PWA 底座，Android 使用原生 WebView 壳，Windows 使用 Electron 壳。

## 当前功能

- 房间列表与创建入口
- 跑团地图、地形、棋子选择与移动
- 角色状态面板，支持 HP / SAN 调整
- 团内聊天记录
- Android 端三页签：地图 / 聊天 / 角色，语音为全局浮动胶囊
- Socket.IO 实时同步
- LiveKit 高清语音接入点，未配置时显示演示状态
- Docker Compose 部署草案，包含 Web、Server、LiveKit、Caddy

## 本地开发

```bash
npm install
npm run dev
```

本地地址：

```text
http://localhost:5173
```

后端健康检查：

```text
http://localhost:8787/health
```

## 源码结构

```text
apps/web                 Web/PWA 前端
apps/server              Node.js 后端与实时同步服务
apps/native/android-webview   Android WebView 壳源码
apps/native/windows-electron  Windows Electron 壳源码
deploy                   Docker Compose / Caddy / LiveKit 部署文件
docs                     部署和 PWA 文档
scripts                  构建、校验、部署和 UI 检查脚本
```

`output/` 只用于本机生成包体、截图、SDK、Gradle/Electron 缓存和发布镜像，不属于源码仓库。

## 测试

```bash
npm run lint
npm run test
npm run build
npm run smoke
```

UI 截图输出在：

```text
output/playwright/tabletop-desktop.png
output/playwright/mobile-map-final.png
output/playwright/mobile-chat-final.png
output/playwright/mobile-characters-final.png
```

`npm run smoke` 需要先运行 `npm run dev`，会检查后端健康、房间、账号注册/登录、LiveKit token 占位和 PWA manifest。

## 原生包构建

```bash
npm run build
npm run sync:native-assets
npm run native:verify-assets
```

Windows 安装包使用 `apps/native/windows-electron` 的 Electron Builder 配置。Android APK 使用 `apps/native/android-webview` 的 Gradle 项目，Android SDK 可来自 `ANDROID_HOME` / `ANDROID_SDK_ROOT`，签名密钥通过 `PAOTUAN_ANDROID_KEYSTORE`、`PAOTUAN_ANDROID_KEYSTORE_PASSWORD`、`PAOTUAN_ANDROID_KEY_ALIAS`、`PAOTUAN_ANDROID_KEY_PASSWORD` 提供；真实 keystore 不应提交到仓库。

## 语音配置

后端通过这些环境变量签发 LiveKit token：

```text
LIVEKIT_URL
LIVEKIT_API_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
VERIFICATION_CODE_SECRET
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
SMTP_FROM
EMAIL_FROM_NAME
SMTP_TIMEOUT_MS
RESEND_API_KEY
RESEND_FROM
RESEND_FROM_NAME
```

`LIVEKIT_URL` 是客户端加入语音房间使用的地址，通常为 `wss://语音域名`。`LIVEKIT_API_URL` 是后端 RoomService 管理接口地址，用于关闭房间、移除旧参与者和发布前连通性检查；Docker Compose 内部推荐设为 `http://livekit:7880`。未配置时，前端会停留在语音演示状态，不会阻断其他跑团功能。

## 邮箱验证码

注册必须先通过 `/api/auth/verification-code` 获取邮箱验证码。Cloud Mail 可用于域内收件和站内邮箱；要覆盖 QQ、Gmail、Outlook 等外部邮箱，生产环境需要配置 Resend 或 SMTP 中继：

```text
CLOUD_MAIL_BASE_URL=https://mail.example.com
CLOUD_MAIL_EMAIL=发信账号@example.com
CLOUD_MAIL_PASSWORD=replace-with-cloud-mail-password
CLOUD_MAIL_TOKEN=
CLOUD_MAIL_ACCOUNT_ID=
EMAIL_DELIVERY_MODE=resend
RESEND_API_KEY=Resend API Key
RESEND_FROM=no-reply@example.com
RESEND_FROM_NAME=Night Table
CLOUD_MAIL_FROM=
CLOUD_MAIL_FROM_NAME=夜航跑团桌
CLOUD_MAIL_TIMEOUT_MS=10000
VERIFICATION_CODE_SECRET=replace-with-random-secret
```

邮件通道优先级：`EMAIL_DELIVERY_MODE=console` 显式调试 > `resend/smtp/cloud-mail` 显式指定 > 默认 Resend > Cloud Mail > SMTP > 本地开发 console。外部邮箱验证码建议设置 `EMAIL_DELIVERY_MODE=resend` 或 `EMAIL_DELIVERY_MODE=smtp`；未开启 Resend 的 Cloud Mail 只能给站内邮箱发件。生产环境不要保留 `EMAIL_DELIVERY_MODE=console` 或 `EMAIL_DEBUG_CODE=true`。

## 部署

部署文件在 `deploy/`，步骤见 `docs/deployment.md`。不要把服务器密码、LiveKit secret、TURN 密码提交到仓库；使用 `deploy/.env` 保存真实值。

Windows 本地远程部署入口：

```powershell
npm run deploy:remote -- -HostName 203.0.113.10 -User root -EnvFile H:\path\to\paotuan.env
```

没有域名时可以先跑 IP 内测：

```powershell
npm run deploy:remote -- -HostName 203.0.113.10 -User root -EnvFile H:\path\to\paotuan-http.env -HttpOnly
```
