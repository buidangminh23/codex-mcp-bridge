import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("dist/server", { recursive: true });
mkdirSync("dist/.openai", { recursive: true });
copyFileSync("worker/index.mjs", "dist/server/index.js");
copyFileSync(".openai/hosting.json", "dist/.openai/hosting.json");
console.log("Built Codex Bridge Worker");
