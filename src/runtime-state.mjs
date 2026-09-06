import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function createRuntimeState({ directory = path.dirname(fileURLToPath(import.meta.url)), configuration = () => null } = {}) {
  const fingerprint = () => {
    const hash = createHash("sha256");
    for (const file of ["../package.json", ...readdirSync(directory).filter((file) => file.endsWith(".mjs")).sort()]) {
      hash.update(file).update("\0").update(readFileSync(path.join(directory, file))).update("\0");
    }
    return hash.digest("hex");
  };
  const revision = fingerprint();
  const configured = JSON.stringify(configuration());
  const startedAt = new Date().toISOString();
  const status = () => {
    let diskRevision = null;
    let reason = null;
    try {
      diskRevision = fingerprint();
      if (diskRevision !== revision) reason = "Bridge source changed after this MCP process started";
      else if (JSON.stringify(configuration()) !== configured) reason = "Bridge routing configuration changed after this MCP process started";
    } catch {
      reason = "Bridge source or routing configuration can no longer be read";
    }
    return { pid: process.pid, startedAt, revision, diskRevision, current: reason === null, reason };
  };
  const assertCurrent = () => {
    const state = status();
    if (!state.current) throw new Error(`${state.reason}. Reconnect this MCP server in the existing Desktop task before sending. No message was sent; do not create a replacement task or use an external app-server.`);
  };
  return { status, assertCurrent };
}
