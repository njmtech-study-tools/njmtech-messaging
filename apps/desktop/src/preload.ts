import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ephemeralDesktop", {
  platform: "desktop",
  setBadge: (n: number) => ipcRenderer.send("badge", n),
  focus: () => ipcRenderer.send("focus"),
});
