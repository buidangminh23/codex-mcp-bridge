import assert from "node:assert/strict";
import { it } from "node:test";
import { retargetMcpServerToml, scanTomlStatements } from "../src/codex-mcp-toml.mjs";

const SUPERVISOR = { command: "/signed/node", args: ["/bridge/src/mcp-supervisor.mjs", "native-relay-companion.mjs"] };
const RELAY = `model = "gpt"
# top comment

[mcp_servers.claude-bridge]
command = "/node"
args = ["/bridge/src/claude-bridge.mjs"]

[mcp_servers.claude-bridge.env]
CODEX_BRIDGE_AUTOSTART = "0"

[mcp_servers.codex-native-relay]
command = "/old/node" # runtime
args = ["/bridge/src/native-relay-companion.mjs"]
env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]
startup_timeout_sec = 30

[mcp_servers.other]
command = "/other"
`;

it("retargets only command and args and keeps every other byte, including env_vars and comments", () => {
  const updated = retargetMcpServerToml(RELAY, "codex-native-relay", { ...SUPERVISOR, ensureEnvVars: ["CODEX_APP_TOOLS_PIPE_PATH"] });
  assert.equal(updated, RELAY
    .replace('command = "/old/node" # runtime', 'command = "/signed/node" # runtime')
    .replace('args = ["/bridge/src/native-relay-companion.mjs"]', 'args = ["/bridge/src/mcp-supervisor.mjs", "native-relay-companion.mjs"]'));
});

it("adds a missing env_vars list after args and appends to an existing one without duplicates", () => {
  const plain = 'x = 1\n\n[mcp_servers.r]\ncommand = "/n"\nargs = ["/a"]\n\n[t]\ny = 2\n';
  assert.equal(retargetMcpServerToml(plain, "r", { command: "/n", args: ["/s", "c"], ensureEnvVars: ["PIPE"] }),
    'x = 1\n\n[mcp_servers.r]\ncommand = "/n"\nargs = ["/s", "c"]\nenv_vars = ["PIPE"]\n\n[t]\ny = 2\n');
  const listed = '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = [\'KEEP\']\n';
  assert.equal(retargetMcpServerToml(listed, "r", { command: "/n", args: ["/s"], ensureEnvVars: ["PIPE", "KEEP"] }),
    '[mcp_servers.r]\ncommand = "/n"\nargs = ["/s"]\nenv_vars = [\'KEEP\', "PIPE"]\n');
});

it("appends to a multi-line env_vars array in place and keeps its comments, quoting and line endings", () => {
  const options = { command: "/n", args: [], ensureEnvVars: ["PIPE", "KEEP", "PIPE", "NEXT"] };
  const annotated = '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = [\n  \'KEEP\', # kept for the relay\n]\n';
  assert.equal(retargetMcpServerToml(annotated, "r", options),
    '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = [\n  \'KEEP\', # kept for the relay\n  "PIPE",\n  "NEXT",\n]\n');
  const bare = '[mcp_servers.r]\r\ncommand = "/n"\r\nargs = []\r\nenv_vars = [\r\n    "KEEP" # no trailing comma\r\n]\r\n';
  assert.equal(retargetMcpServerToml(bare, "r", options),
    '[mcp_servers.r]\r\ncommand = "/n"\r\nargs = []\r\nenv_vars = [\r\n    "KEEP", # no trailing comma\r\n    "PIPE",\r\n    "NEXT"\r\n]\r\n');
  const empty = '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = [\n  # none yet\n]\n';
  assert.equal(retargetMcpServerToml(empty, "r", options),
    '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = [\n  # none yet\n  "PIPE",\n  "KEEP",\n  "NEXT",\n]\n');
  const inline = '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = ["KEEP", # first\n  "OTHER"]\n';
  assert.equal(retargetMcpServerToml(inline, "r", options),
    '[mcp_servers.r]\ncommand = "/n"\nargs = []\nenv_vars = ["KEEP", # first\n  "OTHER", "PIPE", "NEXT"]\n');
  for (const source of [annotated, bare, empty, inline]) scanTomlStatements(retargetMcpServerToml(source, "r", options));
});

it("replaces a multi-line args array with comments and keeps CRLF line endings", () => {
  const source = '[mcp_servers."r"]\r\ncommand = \'C:\\node.exe\'\r\nargs = [\r\n  "C:\\\\old.mjs", # entry\r\n  "x",\r\n]\r\n[other]\r\nk = "v"\r\n';
  const updated = retargetMcpServerToml(source, "r", { command: "C:\\node.exe", args: ["C:\\bridge\\mcp-supervisor.mjs", "claude-bridge.mjs"], ensureEnvVars: ["PIPE"] });
  assert.equal(updated, '[mcp_servers."r"]\r\ncommand = "C:\\\\node.exe"\r\nargs = ["C:\\\\bridge\\\\mcp-supervisor.mjs", "claude-bridge.mjs"]\r\nenv_vars = ["PIPE"]\r\n[other]\r\nk = "v"\r\n');
});

it("adds args when the entry has only a command", () => {
  assert.equal(retargetMcpServerToml('[mcp_servers.r]\ncommand = "/n"', "r", { command: "/m", args: ["/s"] }),
    '[mcp_servers.r]\ncommand = "/m"\nargs = ["/s"]\n');
});

it("ignores look-alike headers inside strings and other tables", () => {
  const source = 'note = """\n[mcp_servers.r]\ncommand = "fake"\n"""\n[mcp_servers.r]\ncommand = "/n"\nargs = ["/a"]\n[mcp_servers.r.env]\ncommand = "env-value"\n';
  const updated = retargetMcpServerToml(source, "r", { command: "/m", args: ["/s"] });
  assert.equal(updated, source.replace('command = "/n"\nargs = ["/a"]', 'command = "/m"\nargs = ["/s"]'));
});

it("refuses configurations it cannot edit unambiguously", () => {
  const cases = [
    ["missing table", '[mcp_servers.other]\ncommand = "/n"\n', /exactly one/],
    ["duplicate table", '[mcp_servers.r]\ncommand = "/n"\n[mcp_servers.r]\nargs = []\n', /exactly one/],
    ["no command", '[mcp_servers.r]\nargs = []\n', /no command/],
    ["dotted definition elsewhere", 'mcp_servers.r.args = []\n[mcp_servers.r]\ncommand = "/n"\n', /outside its table/],
    ["unparseable", '[mcp_servers.r]\ncommand = "/n\n', /could not be scanned safely/],
    ["non-string env_vars", '[mcp_servers.r]\ncommand = "/n"\nenv_vars = [1]\n', /not a string list/],
  ];
  for (const [label, source, pattern] of cases) {
    assert.throws(() => retargetMcpServerToml(source, "r", { command: "/m", args: [], ensureEnvVars: ["PIPE"] }), pattern, label);
  }
});

it("scans inline tables, nested arrays, and literal strings without losing statement boundaries", () => {
  const statements = scanTomlStatements("a = { b = [1, [2, 3]], c = 'x#y' } # tail\n[[arr]]\nd = '''\n[not.a.table]\n'''\n");
  assert.deepEqual(statements.map((statement) => [statement.kind, statement.path.join(".")]), [["value", "a"], ["array-table", "arr"], ["value", "d"]]);
});

it("keeps a UTF-8 byte order mark", () => {
  assert.equal(retargetMcpServerToml('﻿[mcp_servers.r]\ncommand = "/n"\nargs = []\n', "r", { command: "/m", args: ["/s"] }),
    '﻿[mcp_servers.r]\ncommand = "/m"\nargs = ["/s"]\n');
});

it("scans TOML datetimes written with a space separator", () => {
  const source = 'checked = 1979-05-27 07:32:00Z\nlist = [1979-05-27 07:32:00, 2026-10-20]\n[mcp_servers.r]\ncommand = "/n"\nargs = []\n';
  assert.equal(retargetMcpServerToml(source, "r", { command: "/m", args: ["/s"] }), source.replace('command = "/n"\nargs = []', 'command = "/m"\nargs = ["/s"]'));
});
