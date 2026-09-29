import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { OwnedStdioTransport } from "./helpers/owned-stdio-transport.mjs";

it("waits for a delayed child to close before deleting its working directory", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-close-"));
  const transport = new OwnedStdioTransport({ command: process.execPath, args: ["-e", `
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");
    process.stdin.resume();
    process.stdin.on("end", () => setTimeout(() => process.exit(0), 4500));
  `], cwd: directory, env: process.env });
  try {
    const ready = new Promise((resolve) => { transport.onmessage = resolve; });
    await transport.start();
    await ready;
    const started = performance.now();
    await transport.close();
    assert.ok(performance.now() - started >= 4400);
    assert.equal(transport.child.exitCode, 0);
    fs.rmSync(directory, { recursive: true });
    assert.equal(fs.existsSync(directory), false);
  } finally {
    await transport.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("shutdown drains a slow owned inspector before the bridge exits", { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-inspector-close-"));
  const moduleUrl = new URL("../src/claude-sender-context.mjs", import.meta.url).href;
  const transport = new OwnedStdioTransport({ command: process.execPath, args: ["--input-type=module", "-e", `
    import { runProcessInspector, stopProcessInspectors } from ${JSON.stringify(moduleUrl)};
    import fs from "node:fs";
    const inspected = runProcessInspector(process.execPath, ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 60000)"], { timeout: 60000 }).catch(error => error);
    process.stdin.resume();
    process.stdin.once("end", async () => {
      await stopProcessInspectors();
      const result = await inspected;
      fs.writeFileSync("inspector-result.json", JSON.stringify({ pid: result.pid, code: result.code, cleanupFailed: result.cleanupFailed }));
    });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");
  `], cwd: directory, env: process.env });
  try {
    const ready = new Promise((resolve) => { transport.onmessage = resolve; });
    await transport.start();
    await ready;
    await transport.close();
    const result = JSON.parse(fs.readFileSync(path.join(directory, "inspector-result.json"), "utf8"));
    assert.equal(result.code, "ABORT_ERR");
    assert.equal(result.cleanupFailed, undefined);
    assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
    fs.rmSync(directory, { recursive: true });
  } finally {
    await transport.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
