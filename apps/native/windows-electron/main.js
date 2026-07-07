const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, protocol, session, shell } = require("electron");

const DEFAULT_APP_URL = "http://localhost:8787";
const APP_PROTOCOL = "paotuan";
const rendererIndex = path.join(__dirname, "renderer", "index.html");
const rendererRoot = path.join(__dirname, "renderer");
const runtimeConfigPath = path.join(__dirname, "native-runtime.json");

function readRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
  } catch {
    return {};
  }
}

const runtimeConfig = readRuntimeConfig();
const APP_URL = process.env.PAOTUAN_APP_URL || runtimeConfig.appUrl || runtimeConfig.apiBase || DEFAULT_APP_URL;

function shouldTrustInsecureAppOrigin() {
  try {
    return process.env.PAOTUAN_ALLOW_INSECURE_MEDIA === "true" && new URL(APP_URL).protocol === "http:";
  } catch {
    return false;
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);

if (shouldTrustInsecureAppOrigin()) {
  app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", APP_URL);
}
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function resolveRendererPath(url) {
  const target = new URL(url);
  if (target.hostname !== "app") {
    return null;
  }
  const pathname = decodeURIComponent(target.pathname || "/");
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(rendererRoot, relativePath);
  const rootPath = path.resolve(rendererRoot);
  if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) {
    return null;
  }
  return filePath;
}

function registerRendererProtocol() {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const filePath = resolveRendererPath(request.url);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const contentType = mimeTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
      return new Response(data, { headers: { "content-type": contentType } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function isAppOrigin(url) {
  try {
    const target = new URL(url);
    return (
      (target.protocol === `${APP_PROTOCOL}:` && target.hostname === "app") ||
      target.origin === new URL(APP_URL).origin
    );
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) {
    shell.openExternal(url);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "夜航跑团桌",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const url = webContents.getURL();
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const microphoneOnlyMediaRequest =
      permission === "media" && mediaTypes.includes("audio") && !mediaTypes.includes("video");
    if (isAppOrigin(url) && (permission === "microphone" || microphoneOnlyMediaRequest)) {
      callback(true);
      return;
    }
    callback(false);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppOrigin(url)) {
      return { action: "allow" };
    }
    openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAppOrigin(url)) {
      return;
    }
    event.preventDefault();
    openExternal(url);
  });

  win.webContents.on("before-input-event", (event, input) => {
    const key = input.key || "";
    const browserHistoryKey =
      key === "BrowserBack" ||
      key === "BrowserForward" ||
      (input.alt && (key === "ArrowLeft" || key === "ArrowRight"));
    if (input.type === "keyDown" && browserHistoryKey) {
      event.preventDefault();
    }
  });

  if (fs.existsSync(rendererIndex)) {
    win.loadURL(`${APP_PROTOCOL}://app/index.html`);
  } else {
    win.loadURL(APP_URL);
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerRendererProtocol();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
