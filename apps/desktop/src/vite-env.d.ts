/// <reference types="vite/client" />

import type { HtmlslideDesktopApi } from "./desktop-api";

declare global {
  interface Window {
    htmlslideDesktop?: HtmlslideDesktopApi;
  }
}
