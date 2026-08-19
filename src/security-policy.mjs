import { realpathSync } from "node:fs";
import path from "node:path";

const APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOXES = new Set(["read-only", "workspace-write"]);

/**
 * Resolves the deepest ancestor that exists and re-appends the rest, rather
 * than giving up on the whole path when the leaf is missing. Falling back to
 * the unresolved path made containment depend on the platform: macOS puts
 * temporary and home directories behind symlinks (/var -> /private/var), so an
 * allowed root canonicalised while a missing candidate did not, and the two
 * stopped sharing a prefix; on Linux, with no symlink in the way, the same
 * pair matched. Same policy, opposite answer, decided by a detail of the disk.
 *
 * Resolving the existing prefix keeps the protection that matters: a symlink
 * pointing out of an allowed root resolves to where it really goes, so it is
 * still recognised as outside.
 */
function canonicalPath(input) {
  const resolved = path.resolve(input);
  let head = resolved;
  const missing = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...missing);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return resolved;
      missing.unshift(path.basename(head));
      head = parent;
    }
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

  /**
   * Listing is gated on the workspace root, not on the send allowlist. Gating
   * both ways left no path to a thread id at all: you cannot allowlist a
   * thread whose id you have no way to learn, so the only usable thread was
   * one the bridge had created itself. An operator who names a root has
   * declared that project in scope, and the id is still useless without being
   * allowlisted for the calls that act.
   */
  filterThreads(threads) {
    return threads.filter((thread) => this.isCwdAuthorized(thread?.cwd));
  }

  isCwdAuthorized(cwd) {
    if (!this.allowedRoots.length || !cwd) return false;
    const candidate = canonicalPath(cwd);
    return this.allowedRoots.some((root) => isWithin(root, candidate));
  }

  assertCwd(cwd) {
    if (!this.allowedRoots.length) {
      throw new Error(
        "No authorized workspace roots are configured. Set CODEX_BRIDGE_ALLOWED_ROOTS to one or more project directories.",
      );
    }
    if (this.isCwdAuthorized(cwd)) return;
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
