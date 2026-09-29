import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const execute = promisify(execFile);

export class OwnedStdioTransport extends StdioServerTransport {
  constructor({ command, args, cwd, env, closeTimeout = 35000 }) {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    super(child.stdout, child.stdin);
    this.child = child;
    this.closeTimeout = closeTimeout;
    this.stderr = "";
    child.stderr.on("data", (data) => { this.stderr = (this.stderr + data).slice(-8192); });
    child.stdin.on("error", (error) => { this.onerror?.(error); });
    child.on("error", (error) => { this.onerror?.(error); });
    this.closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  }

  get pid() { return this.child.pid; }

  async waitForClose(timeout) {
    let timer;
    try {
      return await Promise.race([
        this.closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Bridge process ${this.pid} did not close within ${timeout} ms\n${this.stderr}`)), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  close() {
    return this.closing ??= (async () => {
      await super.close();
      this.child.stdin.end();
      try { await this.waitForClose(this.closeTimeout); }
      catch (error) {
        if (process.platform === "win32" && this.child.exitCode === null && this.child.signalCode === null) {
          await execute("taskkill.exe", ["/PID", String(this.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }).catch((killError) => { error.cause = killError; });
        } else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
        await this.waitForClose(10000);
        throw error;
      }
    })();
  }
}
