import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReleaseSnapshot, sourceRevision } from "../src/release-snapshot.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = `
import fs from 'node:fs';
import readline from 'node:readline';
import { createReloadControl } from './reload-control.mjs';
const VERSION = 'A';
const ENTRY = process.env.TEST_ENTRY;
let records = [];
let pending = false;
let reverseId = 0;
const reverse = new Map();
const reply = message => process.stdout.write(JSON.stringify(message) + '\\n');
const control = createReloadControl({entry: ENTRY, inspect: () => pending ? 'Waiting for original reply' : null,
  exportState: () => ({records}), restore: state => { if (VERSION === 'FAIL_RESTORE') throw new Error('Incompatible saved state'); records = state.records; }});
control.listen();
readline.createInterface({input: process.stdin}).on('line', async line => {
  const msg = JSON.parse(line);
  if (!msg.method) { const done = reverse.get(msg.id); if (done) { reverse.delete(msg.id); done(msg.result); } return; }
  if (!Object.hasOwn(msg, 'id')) return;
  try {
    let result;
    if (msg.method === 'initialize') result = {protocolVersion:msg.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:VERSION}};
    else if (msg.method === 'tools/list') result = {tools:[{name:'codex_bridge_status',description:'Read test worker',inputSchema:{type:'object'}}]};
    else if (msg.method === 'ping') result = {};
    else result = await control.run(async () => {
      const name = msg.params.name;
      if (name === 'hold') pending = true;
      if (name === 'release') pending = false;
      if (name === 'add' || name === 'slow' || name === 'crash') {
        records.push(msg.params.arguments.value);
        fs.appendFileSync(process.env.TEST_LEDGER, msg.params.arguments.value + '\\n');
      }
      if (name === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
      if (name === 'crash') process.exit(9);
      let roots;
      if (name === 'reverse') roots = await new Promise(resolve => {
        const id = ++reverseId; reverse.set(id, resolve); reply({jsonrpc:'2.0',id,method:'roots/list'});
      });
      return {content:[{type:'text',text:VERSION}],structuredContent:{version:VERSION,records,pending,roots,meta:msg.params._meta}};
    });
    reply({jsonrpc:'2.0',id:msg.id,result});
  } catch(error) { reply({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:error.message}}); }
});
process.on('disconnect', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
`;

function installation(t, entry = "index.mjs") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-supervisor-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","version":"1"}');
  fs.copyFileSync(path.join(repository, "src/reload-control.mjs"), path.join(root, "src/reload-control.mjs"));
  fs.writeFileSync(path.join(root, "src", entry), workerSource);
  const launcher = path.join(root, "launcher.mjs");
  fs.writeFileSync(launcher, `import {runSupervisor} from ${JSON.stringify(new URL("../src/mcp-supervisor.mjs", import.meta.url).href)}; await runSupervisor(${JSON.stringify(entry)}, {root:${JSON.stringify(root)}});`);
  return { root, entry, launcher, ledger: path.join(root, "ledger.txt"), cleanup() { fs.rmSync(root, { recursive: true, force: true }); }, update(version) { fs.writeFileSync(path.join(root, "src", entry), workerSource.replace("const VERSION = 'A'", `const VERSION = '${version}'`)); } };
}

async function connect(t, fixture, extraEnv = {}) {
  const client = new Client({ name: "reload-test", version: "1" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: "file:///test-project" }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture.launcher], env: {
    ...process.env, CODEX_BRIDGE_RUNTIME_CACHE: path.join(fixture.root, "cache"), CODEX_BRIDGE_RELOAD_POLL_MS: "100",
    CODEX_BRIDGE_RELOAD_SETTLE_MS: "100", TEST_ENTRY: fixture.entry, TEST_LEDGER: fixture.ledger,
    ...extraEnv,
  }, stderr: "pipe" });
  let stderr = "";
  transport.stderr.on("data", data => { stderr += data; if(process.env.TEST_RELOAD_DEBUG) process.stderr.write(data); });
  t.after(async () => { await client.close(); fixture.cleanup(); });
  await client.connect(transport);
  return { client, call: (name = "codex_bridge_status", args = {}, meta) => client.callTool({name, arguments: args, ...(meta ? {_meta:meta} : {})}), stderr: () => stderr };
}

async function eventually(read, predicate, errorDetails = () => "") {
  const deadline = Date.now() + 12000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < deadline);
  assert.fail(`Reload did not settle: ${JSON.stringify(value)} ${errorDetails()}`);
}

for (const entry of ["index.mjs", "claude-bridge.mjs", "native-relay-companion.mjs"]) {
  it(`reloads ${entry} on the same MCP connection and retains completed state`, async t => {
    const fixture = installation(t, entry);
    const api = await connect(t, fixture);
    const before = await api.call();
    await api.call("add", {value:"original"});
    fixture.update("B");
    const after = await eventually(api.call, value => value.structuredContent.version === "B", api.stderr);
    assert.equal(after.structuredContent.autoReload.supervisorPid, before.structuredContent.autoReload.supervisorPid);
    assert.notEqual(after.structuredContent.autoReload.workerPid, before.structuredContent.autoReload.workerPid);
    assert.deepEqual(after.structuredContent.records, ["original"]);
    assert.equal(after.structuredContent.autoReload.reloads, 1);
    assert.equal(fs.readFileSync(fixture.ledger, "utf8"), "original\n");
    const reverse = await api.call("reverse", {}, {"test/caller":"preserved"});
    assert.deepEqual(reverse.structuredContent.roots.roots, [{uri:"file:///test-project"}]);
    assert.equal(reverse.structuredContent.meta["test/caller"], "preserved");
  });
}

it("retains pending deliveries and waits until their original result is confirmed", async t => {
  const fixture = installation(t);
  const api = await connect(t, fixture);
  await api.call("add", {value:"pending-message"});
  await api.call("hold");
  fixture.update("B");
  const deferred = await eventually(api.call, value => value.structuredContent.autoReload.reason?.includes("original reply"));
  assert.equal(deferred.structuredContent.version, "A");
  await api.call("release");
  const after = await eventually(api.call, value => value.structuredContent.version === "B", api.stderr);
  assert.deepEqual(after.structuredContent.records, ["pending-message"]);
  assert.equal(fs.readFileSync(fixture.ledger, "utf8"), "pending-message\n");
});

it("does not interrupt active calls and does not replay writes after a worker crash", async t => {
  const fixture = installation(t);
  const api = await connect(t, fixture);
  const slow = api.call("slow", {value:"once"});
  await new Promise(resolve => setTimeout(resolve, 30));
  fixture.update("B");
  assert.equal((await slow).structuredContent.version, "A");
  await eventually(api.call, value => value.structuredContent.version === "B", api.stderr);
  await assert.rejects(api.call("crash", {value:"uncertain"}), /not retried|may be unknown/);
  await assert.rejects(api.call("add", {value:"must-not-send"}), /unknown/);
  assert.equal(fs.readFileSync(fixture.ledger, "utf8"), "once\nuncertain\n");
});

it("keeps the old worker available when an updated release cannot initialize", async t => {
  const fixture = installation(t);
  const api = await connect(t, fixture);
  await api.call("add", {value:"saved"});
  fs.writeFileSync(path.join(fixture.root,"src",fixture.entry), "this is invalid JavaScript;");
  const failed = await eventually(api.call, value => value.structuredContent.autoReload.reason?.includes("Update deferred"), api.stderr);
  assert.equal(failed.structuredContent.version,"A");
  fixture.update("C");
  const after = await eventually(api.call, value => value.structuredContent.version === "C", api.stderr);
  assert.deepEqual(after.structuredContent.records,["saved"]);
});

it("copies dependencies instead of sharing mutable installed files", t => {
  const fixture = installation(t);
  t.after(()=>fixture.cleanup());
  const file = path.join(fixture.root,"node_modules","dependency.js");
  fs.writeFileSync(file,"original");
  const revision = sourceRevision(fixture.root);
  const snapshot = createReleaseSnapshot(fixture.root,{cache:path.join(fixture.root,"cache"),expectedRevision:revision});
  fs.writeFileSync(file,"changed");
  assert.equal(fs.readFileSync(path.join(snapshot.directory,"node_modules","dependency.js"),"utf8"),"original");
  assert.equal(fs.lstatSync(path.join(snapshot.directory,"node_modules")).isSymbolicLink(),false);
});

it("resumes the original worker if candidate state restoration fails", async t => {
  const fixture = installation(t);
  const api = await connect(t, fixture);
  await api.call("add", {value:"saved"});
  fixture.update("FAIL_RESTORE");
  const failed = await eventually(api.call, value => value.structuredContent.autoReload.reason?.includes("Incompatible saved state"), api.stderr);
  assert.equal(failed.structuredContent.version, "A");
  assert.deepEqual(failed.structuredContent.records, ["saved"]);
  await api.call("add", {value:"after-rollback"});
  fixture.update("B");
  const after = await eventually(api.call, value => value.structuredContent.version === "B", api.stderr);
  assert.deepEqual(after.structuredContent.records, ["saved", "after-rollback"]);
  assert.equal(fs.readFileSync(fixture.ledger, "utf8"), "saved\nafter-rollback\n");
});

for (const [entry, statusName] of [["index.mjs", "codex_bridge_status"], ["claude-bridge.mjs", "claude_bridge_status"], ["native-relay-companion.mjs", "native_relay_status"]]) {
  it(`upgrades the real ${entry} without reconnecting its MCP client`, {timeout:180000}, async t => {
    const fixture = installation(t, entry);
    fs.cpSync(path.join(repository, "src"), path.join(fixture.root, "src"), {recursive:true});
    fs.copyFileSync(path.join(repository,"package.json"),path.join(fixture.root,"package.json"));
    fs.cpSync(path.join(repository,"node_modules"),path.join(fixture.root,"node_modules"),{recursive:true});
    const prefix = process.platform === "win32" ? `\\\\.\\pipe\\supervisor-${randomUUID()}` : path.join(fixture.root,"native.sock");
    const sockets = new Set();
    const native = net.createServer(socket => { sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); });
    await new Promise(resolve=>native.listen(prefix,resolve));
    t.after(async()=>{for(const socket of sockets) socket.destroy(); await new Promise(resolve=>native.close(resolve));});
    const api = await connect(t,fixture,{
      HOME: fixture.root, USERPROFILE: fixture.root, CODEX_HOME: path.join(fixture.root,".codex"), APPDATA:path.join(fixture.root,"Roaming"),
      LOCALAPPDATA:path.join(fixture.root,"Local"), CODEX_BRIDGE_AUTOSTART:"0", CODEX_BRIDGE_DESKTOP_TASKS:"0",
      CODEX_APP_SERVER_URL:"ws://127.0.0.1:9", CODEX_NATIVE_RELAY_SOCKET:`${prefix}-relay`, CODEX_APP_TOOLS_PIPE_PATH:prefix,
    });
    const before=await api.call(statusName);
    assert.equal(before.structuredContent.autoReload.enabled,true);
    fs.appendFileSync(path.join(fixture.root,"src",entry),"\n");
    const after=await eventually(()=>api.call(statusName),value=>value.structuredContent?.autoReload?.reloads === 1,api.stderr);
    assert.equal(after.structuredContent.autoReload.supervisorPid,before.structuredContent.autoReload.supervisorPid);
    assert.notEqual(after.structuredContent.autoReload.workerPid,before.structuredContent.autoReload.workerPid);
    assert.equal(after.structuredContent.runtime.current,true);
  });
}
