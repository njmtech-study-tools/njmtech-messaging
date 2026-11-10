import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEV_URL = process.env.ELECTRON_DEV_URL;
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "../../client/dist");
const ICON = path.join(app.isPackaged ? WEB_ROOT : path.join(__dirname, "../../client/public"), "pwa-64x64.png");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// Serve the web build from app:// so it gets a stable, secure origin (IndexedDB, WebCrypto, Notifications).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());
if (process.platform === "win32") app.setAppUserModelId("tech.njm.ephemeral");

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: "Ephemeral",
    icon: ICON,
    backgroundColor: "#0b1220",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep the relay socket and timers running while minimised to the tray.
      backgroundThrottling: false,
    },
  });

  void win.loadURL(DEV_URL ?? "app://ephemeral/index.html");

  // Closing hides to tray so messages keep arriving and notifications still fire.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => (win = null));

  // Open external links in the system browser; never navigate the app window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Ephemeral");
  const rebuild = () =>
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Ephemeral", click: show },
        {
          label: "Launch at login",
          type: "checkbox",
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ["--hidden"] });
            rebuild();
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => ((quitting = true), app.quit()) },
      ]),
    );
  rebuild();
  tray.on("click", show);
}

ipcMain.on("badge", (_e, n: number) => {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  app.setBadgeCount(count); // macOS dock / Linux Unity launchers
  tray?.setToolTip(count ? `Ephemeral — ${count} unread` : "Ephemeral");
  if (process.platform === "win32" && win) win.flashFrame(count > 0 && !win.isFocused());
});
ipcMain.on("focus", () => show());

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(WEB_ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(WEB_ROOT)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Only allow the permissions the app actually needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "notifications"));

  createTray();
  if (!process.argv.includes("--hidden")) createWindow();
  else {
    createWindow();
    win?.hide();
  }
});

app.on("before-quit", () => (quitting = true));
app.on("activate", show);
// Stay alive in the tray on all platforms.
app.on("window-all-closed", () => {});
