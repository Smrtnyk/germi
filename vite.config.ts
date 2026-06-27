import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/cli sets TAURI_DEV_HOST when running on a physical device.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and shows its own errors, so don't clear them.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Don't reload the dev server when Rust files change. This is a Cargo
      // workspace, so build output lands in target/ at the REPO ROOT (not under
      // src-tauri/) — watching it races the linker writing germi_lib.dll and
      // crashes Vite's file watcher with EBUSY on Windows.
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
});
