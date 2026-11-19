import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import net from "node:net";
import { WebSocketServer, createWebSocketStream } from "ws";
import { fleetSshArgs } from "./fleet-host.mjs";

function desktopConnection(host, port) {
  const args = fleetSshArgs(host).slice(0, -3);
  const child = spawn("ssh", [...args, "-W", `127.0.0.1:${port}`, "--", host.sshHost],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.on("error", error => stream.destroy(error));
  child.on("close", code => code ? stream.destroy(new Error("Remote desktop connection failed")) : stream.destroy());
  stream.on("close", () => child.kill());
  return stream;
}

function pipeDesktop(front, remote) {
  const close = () => { front.destroy(); remote.destroy(); };
  for (const stream of [front, remote]) {
    stream.on("error", close);
    stream.on("close", close);
  }
  front.pipe(remote).pipe(front);
}

export function attachFleetScreens(server, { origin, connect = desktopConnection }) {
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 ** 2 });
  const tickets = new Map();
  const listeners = new Set();
  const connections = new Set();
  const track = stream => {
    connections.add(stream);
    stream.once("close", () => connections.delete(stream));
    return stream;
  };
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/screen\/([a-zA-Z0-9_-]{43})$/.exec(request.url);
    const ticket = match && tickets.get(match[1]);
    if (!ticket || ticket.expires < Date.now() || request.headers.origin !== origin() || "http://" + request.headers.host !== origin()) {
      socket.destroy();
      return;
    }
    tickets.delete(match[1]);
    ws.handleUpgrade(request, socket, head, peer => {
      pipeDesktop(createWebSocketStream(peer), track(connect(ticket.host, 5900)));
    });
  });
  return {
    issue(host) {
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expires < now) tickets.delete(key);
      const token = randomBytes(32).toString("base64url");
      tickets.set(token, { host, expires: now + 30000 });
      return { path: "/screen/" + token };
    },
    async rdp(host) {
      const listener = net.createServer(socket => {
        listener.close();
        pipeDesktop(socket, track(connect(host, 3389)));
      });
      listeners.add(listener);
      const timer = setTimeout(() => listener.close(), 90000);
      timer.unref();
      listener.on("close", () => { listeners.delete(listener); clearTimeout(timer); });
      await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
      return { file: `full address:s:127.0.0.1:${listener.address().port}\r\nprompt for credentials:i:1\r\nauthentication level:i:2\r\nredirectclipboard:i:0\r\n` };
    },
    close() {
      for (const listener of listeners) listener.close();
      for (const stream of connections) stream.destroy();
      for (const peer of ws.clients) peer.terminate();
      ws.close();
    },
  };
}
