import { contextBridge } from "electron";
import process from "node:process";

contextBridge.exposeInMainWorld("htmlslideDesktop", {
  appName: "HTMLslide",
  platform: process.platform,
  shell: "electron"
});
