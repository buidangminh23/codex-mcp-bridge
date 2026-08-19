import { realpathSync } from "node:fs";
import path from "node:path";

const APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOXES = new Set(["read-only", "workspace-write"]);

function canonicalPath(input) {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseList(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseRoots(value) {
  return String(value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(canonicalPath);
}

export function assertAllowedAppServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid CODEX_APP_SERVER_URL: ${value}`);
  }
  if (!new Set(["ws:", "wss:"]).has(parsed.protocol)) {
    throw new Error(`CODEX_APP_SERVER_URL must use ws:// or wss://: ${value}`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (!loopback) {
    throw new Error(
      `Refusing non-loopback app-server endpoint ${value}; the bridge only supports authenticated local app-servers`,
    );
  }
  return parsed;
}

export class BridgeSecurityPolicy {
  constructor(env = process.env) {
    this.allowedThreadIds = parseList(env.CODEX_BRIDGE_ALLOWED_THREADS);
    this.allowedRoots = parseRoots(env.CODEX_BRIDGE_ALLOWED_ROOTS);
    this.ownedThreadIds = new Set();

    this.approvalPolicy = env.CODEX_BRIDGE_APPROVAL_POLICY ?? "on-request";
    if (!APPROVAL_POLICIES.has(this.approvalPolicy)) {
      throw new Error(`Invalid CODEX_BRIDGE_APPROVAL_POLICY: ${this.approvalPolicy}`);
    }

    this.sandbox = env.CODEX_BRIDGE_SANDBOX ?? "workspace-write";
    if (!SANDBOXES.has(this.sandbox)) {
      throw new Error(`CODEX_BRIDGE_SANDBOX must be read-only or workspace-write: ${this.sandbox}`);
    }
  }

  registerThread(threadId) {
    if (threadId) this.ownedThreadIds.add(threadId);
  }

  isThreadAuthorized(threadId) {
    return this.ownedThreadIds.has(threadId) || this.allowedThreadIds.has(threadId);
  }

  assertThread(threadId) {
    if (this.isThreadAuthorized(threadId)) return;
    if (!this.allowedThreadIds.size && !this.ownedThreadIds.size) {
      throw new Error(
        "No authorized Codex threads are configured. Set CODEX_BRIDGE_ALLOWED_THREADS or create a thread with start_codex_thread.",
      );
    }
    throw new Error(`Codex thread ${threadId} is not authorized for this bridge`);
  }

  filterThreads(threads) {
    return threads.filter((thread) => this.isThreadAuthorized(thread?.id));
  }

  assertCwd(cwd) {
    if (!this.allowedRoots.length) {
      throw new Error(
        "No authorized workspace roots are configured. Set CODEX_BRIDGE_ALLOWED_ROOTS to one or more project directories.",
      );
    }
    const candidate = canonicalPath(cwd);
    if (this.allowedRoots.some((root) => isWithin(root, candidate))) return;
    throw new Error(`Working directory is outside CODEX_BRIDGE_ALLOWED_ROOTS: ${cwd}`);
  }

  summary() {
    return {
      authorizedThreads: this.allowedThreadIds.size + this.ownedThreadIds.size,
      allowedRoots: this.allowedRoots,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
    };
  }
}
