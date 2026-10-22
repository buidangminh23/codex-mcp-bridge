import fs from "node:fs";
import path from "node:path";

export function relayFileIdentity(target, kind, expected) {
  const root = fs.realpathSync.native(path.dirname(target));
  const name = path.basename(target);
  if (kind === "config" && name !== "native-relay.json") throw new Error("Unexpected relay configuration filename");
  const file = path.resolve(root, name);
  if (!file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) throw new Error("Relay file escaped its directory");
  const current = fs.lstatSync(file, { bigint: true });
  if (current.isSymbolicLink() || (kind === "config" ? !current.isFile() : !current.isSocket())
      || current.nlink !== 1n
      || typeof process.getuid === "function" && current.uid !== BigInt(process.getuid())
      || expected && (current.dev !== expected.dev || current.ino !== expected.ino)) {
    throw new Error(`Unsafe relay ${kind} file: ${target}`);
  }
  return current;
}

export function removeRelayFile(target, { kind = "socket", directory = path.dirname(target), expected } = {}) {
  let root;
  try { root = fs.realpathSync.native(directory); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const name = kind === "config" ? "native-relay.json" : path.basename(target);
  if (path.basename(target) !== name) throw new Error("Unexpected relay configuration filename");
  const file = path.resolve(root, name);
  if (!file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) throw new Error("Relay file escaped its directory");
  let identity;
  try { identity = relayFileIdentity(file, kind, expected); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (fs.realpathSync.native(file) !== file) throw new Error("Relay file is redirected");
  relayFileIdentity(file, kind, identity);
  fs.unlinkSync(file);
  return true;
}

export function verifyRelaySocketMode(target, expected) {
  const current = relayFileIdentity(target, "socket", expected);
  if ((current.mode & 0o777n) !== 0o600n) throw new Error("Relay socket was not created with mode 0600");
}
