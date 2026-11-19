import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = 1;
const FILE_PATTERN = /^\.handshake-[a-f0-9]{64}\.json$/;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOLS = 8;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIGURATION_VARIABLE = /^(?:CODEX_BRIDGE_|CODEX_NATIVE_|CODEX_APP_SERVER_URL$|ANTIGRAVITY_BRIDGE_)/;
const IGNORED_VARIABLES = new Set(["CODEX_BRIDGE_SOURCE_ROOT", "CODEX_BRIDGE_WORKER", "CODEX_BRIDGE_STAGED"]);

function completeCatalog(catalog) {
  return Boolean(catalog) && Array.isArray(catalog.tools) && catalog.tools.length > 0 && !catalog.nextCursor;
}

function usableEntry(entry, protocolVersion) {
  return Boolean(entry) && typeof entry === "object" && entry.initialize?.protocolVersion === protocolVersion
    && entry.initialize.capabilities && typeof entry.initialize.capabilities === "object" && completeCatalog(entry.catalog);
}

export function handshakeIdentity({ root, entry, env }) {
  const hash = createHash("sha256").update(String(SCHEMA)).update("\0").update(root).update("\0").update(entry).update("\0");
  hash.update(fs.readFileSync(path.join(root, "package.json"))).update("\0");
  for (const name of Object.keys(env).filter((key) => CONFIGURATION_VARIABLE.test(key) && !IGNORED_VARIABLES.has(key)).sort()) {
    hash.update(name).update("=").update(String(env[name])).update("\0");
  }
  return hash.digest("hex");
}

export function createHandshakeCache({ directory, identity }) {
  const file = path.join(directory, `.handshake-${identity}.json`);
  const load = () => {
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) return {};
      const saved = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (saved?.schema !== SCHEMA || saved.identity !== identity || !saved.protocols || typeof saved.protocols !== "object" || Array.isArray(saved.protocols)) return {};
      return saved.protocols;
    } catch { return {}; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  };
  const removeStaleSiblings = (now) => {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!FILE_PATTERN.test(name) || path.join(directory, name) === file) continue;
        const sibling = path.join(directory, name);
        const info = fs.lstatSync(sibling);
        if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > STALE_MS) fs.rmSync(sibling, { force: true });
      }
    } catch {}
  };
  return {
    read(protocolVersion) {
      if (typeof protocolVersion !== "string") return null;
      const entry = load()[protocolVersion];
      return usableEntry(entry, protocolVersion) ? { initialize: entry.initialize, catalog: entry.catalog } : null;
    },
    write(protocolVersion, initialize, catalog) {
      if (typeof protocolVersion !== "string" || !usableEntry({ initialize, catalog }, initialize?.protocolVersion)) return false;
      const protocols = load();
      const entry = { initialize, catalog };
      if (JSON.stringify(protocols[protocolVersion]) === JSON.stringify(entry)) return false;
      delete protocols[protocolVersion];
      const kept = Object.fromEntries([...Object.entries(protocols).slice(-(MAX_PROTOCOLS - 1)), [protocolVersion, entry]]);
      const body = JSON.stringify({ schema: SCHEMA, identity, protocols: kept });
      if (Buffer.byteLength(body) > MAX_BYTES) return false;
      const temporary = path.join(directory, `.handshake-${process.pid}-${randomUUID()}.tmp`);
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, file);
        removeStaleSiblings(Date.now());
        return true;
      } catch { return false; }
      finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
    },
    forget() {
      try { fs.rmSync(file, { force: true }); } catch {}
    },
  };
}
