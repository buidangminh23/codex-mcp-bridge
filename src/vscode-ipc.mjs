import net from "node:net";
import { randomUUID } from "node:crypto";

export class VSCodeIpc {
  constructor({ socketPath = "\\\\.\\pipe\\codex-ipc", timeoutMs = 10000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    this.socket = net.createConnection(this.socketPath);
    this.socket.on("data", (data) => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > 16 * 1024 * 1024) throw new Error("Invalid IPC frame length");
          if (this.buffer.length < length + 4) break;
          const frame = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
          this.buffer = this.buffer.subarray(length + 4);
          if (frame.type !== "response") continue;
          const pending = this.pending.get(frame.requestId);
          if (!pending) continue;
          this.pending.delete(frame.requestId);
          clearTimeout(pending.timer);
          if (frame.resultType !== "success") pending.reject(new Error(`IPC ${pending.method}: ${frame.error ?? "request failed"}`));
          else if (pending.target && frame.handledByClientId !== pending.target) pending.reject(new Error("IPC owner changed"));
          else pending.resolve(frame);
        }
      } catch (error) { this.close(error); }
    });
    this.socket.on("error", (error) => this.close(error));
    this.socket.on("close", () => this.close(new Error("IPC connection closed")));
    const response = await this.request("initialize", { clientType: "codex-mcp-bridge" }, 0);
    if (typeof response.result?.clientId !== "string") throw new Error("IPC initialization omitted client identity");
    this.clientId = response.result.clientId;
    return this;
  }

  request(method, params, version = 1, target) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`IPC ${method} timed out; inspect the original task before retrying a send`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method, target });
      const body = Buffer.from(JSON.stringify({ type: "request", requestId, sourceClientId: this.clientId ?? "initializing-client", version, method, params, ...(target ? { targetClientId: target } : {}) }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    });
  }

  async owner(threadId) {
    const response = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId });
    if (!response.handledByClientId) throw new Error("No live owner for this task");
    return response.handledByClientId;
  }

  async send(threadId, message, { beforeSend } = {}) {
    const owner = await this.owner(threadId);
    await beforeSend?.();
    const response = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request: { threadId, input: [{ type: "text", text: message, text_elements: [] }] }, context: { inheritThreadSettings: true } },
    }, 2, owner);
    const turnId = response.result?.result?.turn?.id;
    if (typeof turnId !== "string") throw new Error("Submission was acknowledged without a turn ID; inspect the original task before retrying");
    return { threadId, turnId, owner, status: "submitted" };
  }

  close(error = new Error("IPC client closed")) {
    this.socket?.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}
