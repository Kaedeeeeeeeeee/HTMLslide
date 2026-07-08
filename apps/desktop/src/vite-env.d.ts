/// <reference types="vite/client" />

interface HtmlslideDesktopBridge {
  appName: string;
  platform: string;
  shell: "electron";
}

interface Window {
  htmlslideDesktop?: HtmlslideDesktopBridge;
}
