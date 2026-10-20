const BARE_KEY = /[A-Za-z0-9_-]/;
const WHITESPACE = /[ \t]/;

class TomlScanError extends Error {}

function fail(message) {
  throw new TomlScanError(message);
}

function skipWhitespace(text, index) {
  while (index < text.length && WHITESPACE.test(text[index])) index++;
  return index;
}

function lineEnd(text, index) {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

function readString(text, index) {
  const quote = text[index];
  const multiline = text.startsWith(quote.repeat(3), index);
  const delimiter = multiline ? quote.repeat(3) : quote;
  let cursor = index + delimiter.length;
  let value = "";
  while (cursor < text.length) {
    if (text.startsWith(delimiter, cursor)) {
      let end = cursor + delimiter.length;
      if (multiline) while (text[end] === quote && end - cursor < 5) end++;
      if (multiline) value += quote.repeat(end - cursor - 3);
      return { end, value };
    }
    const character = text[cursor];
    if (!multiline && (character === "\n" || character === "\r")) fail("Unterminated single-line string");
    if (quote === '"' && character === "\\") {
      const escape = text[cursor + 1];
      const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
      if (escape in simple) { value += simple[escape]; cursor += 2; continue; }
      const width = escape === "u" ? 4 : escape === "U" ? 8 : escape === "x" ? 2 : 0;
      if (width) {
        const hex = text.slice(cursor + 2, cursor + 2 + width);
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fail("Invalid string escape");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor += 2 + width;
        continue;
      }
      if (multiline && /[ \t\r\n]/.test(escape)) {
        let next = cursor + 1;
        while (next < text.length && /[ \t]/.test(text[next])) next++;
        if (text[next] === "\r") next++;
        if (text[next] !== "\n") fail("Invalid line-ending backslash");
        while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
        cursor = next;
        continue;
      }
      fail("Invalid string escape");
    }
    value += character;
    cursor++;
  }
  return fail("Unterminated string");
}

function readKey(text, index, terminator) {
  const parts = [];
  let cursor = skipWhitespace(text, index);
  for (;;) {
    if (text[cursor] === '"' || text[cursor] === "'") {
      if (text.startsWith(text[cursor].repeat(3), cursor)) fail("Multi-line strings are not valid keys");
      const string = readString(text, cursor);
      parts.push(string.value);
      cursor = string.end;
    } else {
      const start = cursor;
      while (cursor < text.length && BARE_KEY.test(text[cursor])) cursor++;
      if (cursor === start) fail("Invalid key");
      parts.push(text.slice(start, cursor));
    }
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === ".") { cursor = skipWhitespace(text, cursor + 1); continue; }
    if (!text.startsWith(terminator, cursor)) fail(`Expected ${terminator} after key`);
    return { parts, end: cursor + terminator.length };
  }
}

function skipTrivia(text, index) {
  let cursor = index;
  for (;;) {
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === "#") cursor = lineEnd(text, cursor);
    else if (text[cursor] === "\r" || text[cursor] === "\n") cursor++;
    else return cursor;
  }
}

function readValue(text, index) {
  const character = text[index];
  if (character === '"' || character === "'") return { end: readString(text, index).end };
  if (character === "[" || character === "{") {
    const close = character === "[" ? "]" : "}";
    let cursor = skipTrivia(text, index + 1);
    while (text[cursor] !== close) {
      if (cursor >= text.length) fail("Unterminated array or inline table");
      if (close === "}") {
        const key = readKey(text, cursor, "=");
        cursor = skipWhitespace(text, key.end);
      }
      cursor = skipTrivia(text, readValue(text, cursor).end);
      if (text[cursor] === ",") cursor = skipTrivia(text, cursor + 1);
      else if (text[cursor] !== close) fail("Expected a separator in an array or inline table");
    }
    return { end: cursor + 1 };
  }
  let cursor = index;
  const scalar = () => { while (cursor < text.length && !/[ \t\r\n#,\]}]/.test(text[cursor])) cursor++; };
  scalar();
  if (cursor === index) fail("Missing value");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(index, cursor)) && /^ \d{2}:\d{2}/.test(text.slice(cursor, cursor + 6))) {
    cursor++;
    scalar();
  }
  return { end: cursor };
}

function scan(text) {
  const statements = [];
  let cursor = text.startsWith("\uFEFF") ? 1 : 0;
  while (cursor < text.length) {
    const start = cursor;
    const content = skipWhitespace(text, cursor);
    const character = text[content];
    if (content >= text.length || character === "\n" || character === "\r" || character === "#") {
      cursor = lineEnd(text, content);
      continue;
    }
    if (character === "[") {
      const array = text[content + 1] === "[";
      const key = readKey(text, content + (array ? 2 : 1), array ? "]]" : "]");
      statements.push({ kind: array ? "array-table" : "table", path: key.parts, start });
      cursor = lineEnd(text, key.end);
      continue;
    }
    const key = readKey(text, content, "=");
    const valueStart = skipWhitespace(text, key.end);
    const { end: valueEnd } = readValue(text, valueStart);
    const tail = skipWhitespace(text, valueEnd);
    if (tail < text.length && !["\r", "\n", "#"].includes(text[tail])) fail("Unexpected text after a value");
    cursor = lineEnd(text, valueEnd);
    statements.push({ kind: "value", path: key.parts, start, valueStart, valueEnd, end: cursor });
  }
  return statements;
}

export function scanTomlStatements(text) {
  try { return scan(text); }
  catch (error) {
    if (error instanceof TomlScanError) throw new Error(`The Codex configuration could not be scanned safely (${error.message}); it was not changed`);
    throw error;
  }
}

function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function tomlString(value) {
  return JSON.stringify(String(value)).replaceAll("\u007f", "\\u007F");
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function parseStringArray(text, statement) {
  const raw = text.slice(statement.valueStart, statement.valueEnd);
  if (!raw.startsWith("[")) fail("env_vars is not an array");
  const values = [];
  let cursor = skipTrivia(raw, 1);
  while (raw[cursor] !== "]") {
    if (raw[cursor] !== '"' && raw[cursor] !== "'") fail("env_vars must contain only strings");
    const string = readString(raw, cursor);
    values.push(string.value);
    cursor = skipTrivia(raw, string.end);
    if (raw[cursor] === ",") cursor = skipTrivia(raw, cursor + 1);
  }
  return values;
}

export function retargetMcpServerToml(contents, name, { command, args, ensureEnvVars = [] }) {
  const statements = scanTomlStatements(contents);
  const serverPath = ["mcp_servers", name];
  const headers = statements.filter((statement) => statement.kind !== "value");
  const owners = headers.filter((statement) => statement.kind === "table" && samePath(statement.path, serverPath));
  if (owners.length !== 1) throw new Error(`Expected exactly one [mcp_servers.${name}] table in the Codex configuration; it was not changed`);
  const header = owners[0];
  const sectionEnd = headers.find((statement) => statement.start > header.start)?.start ?? contents.length;
  const section = statements.filter((statement) => statement.kind === "value" && statement.start > header.start && statement.start < sectionEnd);
  for (const statement of statements) {
    if (statement.kind !== "value" || section.includes(statement)) continue;
    const owner = headers.filter((candidate) => candidate.start < statement.start).at(-1);
    const fullPath = [...(owner?.kind === "table" ? owner.path : []), ...statement.path];
    if (samePath(fullPath, serverPath) || ["command", "args", "env_vars"].some((key) => samePath(fullPath, [...serverPath, key]))) {
      throw new Error(`The ${name} MCP entry is also defined outside its table; it was not changed`);
    }
  }
  const find = (key) => {
    const matches = section.filter((statement) => samePath(statement.path, [key]));
    if (matches.length > 1) throw new Error(`The ${name} MCP entry defines ${key} more than once; it was not changed`);
    return matches[0];
  };
  const commandStatement = find("command");
  const argsStatement = find("args");
  if (!commandStatement) throw new Error(`The ${name} MCP entry has no command; it was not changed`);
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const edits = [{ start: commandStatement.valueStart, end: commandStatement.valueEnd, text: tomlString(command) }];
  if (argsStatement) edits.push({ start: argsStatement.valueStart, end: argsStatement.valueEnd, text: tomlArray(args) });
  else edits.push({ start: commandStatement.end, end: commandStatement.end, text: `${contents.slice(commandStatement.end - 1, commandStatement.end) === "\n" ? "" : newline}args = ${tomlArray(args)}${newline}` });
  if (ensureEnvVars.length) {
    const envVarsStatement = find("env_vars");
    if (envVarsStatement) {
      let existing;
      try { existing = parseStringArray(contents, envVarsStatement); }
      catch (error) {
        if (error instanceof TomlScanError) throw new Error(`The ${name} MCP entry has env_vars that are not a string list; it was not changed`);
        throw error;
      }
      const missing = ensureEnvVars.filter((variable) => !existing.includes(variable));
      if (missing.length) edits.push({ start: envVarsStatement.valueStart, end: envVarsStatement.valueEnd, text: tomlArray([...existing, ...missing]) });
    } else {
      const anchor = argsStatement ?? commandStatement;
      const lineBreak = contents.slice(anchor.end - 1, anchor.end) === "\n" ? "" : newline;
      edits.push({ start: anchor.end, end: anchor.end, text: `${lineBreak}env_vars = ${tomlArray(ensureEnvVars)}${newline}`, after: true });
    }
  }
  edits.sort((left, right) => right.start - left.start || (left.after ? 0 : 1) - (right.after ? 0 : 1));
  let updated = contents;
  for (const edit of edits) updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  return updated;
}
