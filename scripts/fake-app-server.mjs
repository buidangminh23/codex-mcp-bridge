import { createHash } from "node:crypto";
import { createServer } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  return Buffer.concat([header, payload]);
}

export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    if ((buffer[offset] & 0x0f) === 0x01) messages.push(payload.toString("utf8"));
    offset = cursor + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/**
 * A stand-in for `codex app-server` that speaks just enough of the wire format
 * to exercise the bridge: the WebSocket handshake, the `initialize` reply, and
 * whatever the test decides to answer. Keeping it dependency-free means the
 * connection tests run anywhere without a real Codex install or quota.
 */
export async function startFakeAppServer({ port, onRequest, autoInitialize = true, failFirstUpgrades = 0 } = {}) {
  const state = { socket: null, replies: [], sockets: new Set(), connections: 0, refused: 0 };

  const http = createServer((req, res) => {
    if (req.url === "/readyz") return res.writeHead(200).end("ok");
    res.writeHead(404).end();
  });

  http.on("upgrade", (req, sock) => {
    if (state.refused < failFirstUpgrades) {
      state.refused += 1;
      sock.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + WS_GUID)
      .digest("base64");
    sock.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    state.socket = sock;
    state.sockets.add(sock);
    state.connections += 1;
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("error", () => state.sockets.delete(sock));

    let buffered = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const { messages, rest } = decodeFrames(buffered);
      buffered = rest;
      for (const raw of messages) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (autoInitialize && msg.method === "initialize") {
          sock.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { codexHome: "/fake" } })));
          continue;
        }
        if (msg.id !== undefined && msg.method === undefined) {
          state.replies.push(msg);
          continue;
        }
        onRequest?.(msg, {
          respond: (result) => sock.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))),
          notify: (method, params) => sock.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", method, params }))),
          socket: sock,
        });
      }
    });
  });

  await new Promise((resolve) => http.listen(port, "127.0.0.1", resolve));

  return {
    ...state,
    get socket() {
      return state.socket;
    },
    get replies() {
      return state.replies;
    },
    get connections() {
      return state.connections;
    },
    get refused() {
      return state.refused;
    },
    send: (payload) => state.socket?.write(encodeFrame(JSON.stringify(payload))),
    dropConnection: () => {
      for (const sock of state.sockets) sock.destroy();
      state.sockets.clear();
    },
    close: () =>
      new Promise((resolve) => {
        for (const sock of state.sockets) sock.destroy();
        http.close(resolve);
      }),
  };
}
