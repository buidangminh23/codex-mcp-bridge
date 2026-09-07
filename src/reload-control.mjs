export function cloneReloadState(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    throw new Error("Reload state is missing or exceeds its transfer limit");
  }
  return JSON.parse(encoded);
}

export function clientReloadReason(client) {
  if (!client) return null;
  for (const field of ["pending", "threadOperations", "attachingThreads", "activeTurns", "threadListeners"]) {
    if (client[field]?.size) return `The app-server still has ${field}`;
  }
  if (client.connecting) return "The app-server connection is still being established";
  return null;
}

export function createReloadControl({ entry, inspect = () => null, quiesce = () => {}, exportState = () => ({}), restore = () => {}, activate = () => {}, resume = activate, env = process.env, channel = process } = {}) {
  if (!["index.mjs", "claude-bridge.mjs", "native-relay-companion.mjs"].includes(entry)) throw new Error("Invalid reload entry point");
  const enabled = env.CODEX_BRIDGE_WORKER === "1" && typeof channel.send === "function";
  let phase = enabled && env.CODEX_BRIDGE_STAGED === "1" ? "staged" : "active";
  let active = 0;
  let deferred = null;
  let listening = false;
  let commands = Promise.resolve();

  const status = () => {
    const reason = active ? "MCP tool calls are still active" : deferred ?? inspect();
    return { reloadable: phase === "active" && !reason, reason: reason ?? (phase === "active" ? null : `The worker is ${phase}`), schema: 1, phase };
  };

  const control = async (action, data) => {
    if (action === "inspect") return status();
    if (action === "quiesce") {
      const current = status();
      if (!current.reloadable) throw new Error(current.reason);
      phase = "quiescing";
      try {
        await quiesce();
        const reason = deferred ?? inspect();
        if (active || reason) throw new Error(reason ?? "A tool call raced with quiescence");
        const state = cloneReloadState({ schema: 1, entry, payload: exportState() });
        phase = "quiesced";
        return { state };
      } catch (error) {
        phase = "quiesced";
        throw error;
      }
    }
    if (action === "restore") {
      if (phase !== "staged") throw new Error("Reload state can only be restored into a staged worker");
      const state = cloneReloadState(data);
      if (!state || state.schema !== 1 || state.entry !== entry || !state.payload || typeof state.payload !== "object" || Array.isArray(state.payload)) {
        throw new Error("Reload state schema or entry point does not match this worker");
      }
      await restore(state.payload);
      return { restored: true, schema: 1 };
    }
    if (action === "activate" || action === "resume") {
      if (phase === "active") return { active: true, schema: 1 };
      if (action === "activate" && phase !== "staged" || action === "resume" && phase !== "quiesced") {
        throw new Error(`Cannot ${action} a ${phase} worker`);
      }
      await (action === "activate" ? activate() : resume());
      phase = "active";
      return { active: true, schema: 1 };
    }
    throw new Error("Unknown bridge control action");
  };

  return {
    get staged() { return phase === "staged"; },
    inspect: status,
    defer(reason) { deferred ??= String(reason); },
    async run(handler) {
      if (phase !== "active") throw new Error(`Bridge worker is ${phase}; no tool operation was started`);
      active += 1;
      try { return await handler(); }
      finally { active -= 1; }
    },
    control,
    listen() {
      if (!enabled || listening) return;
      listening = true;
      channel.on("message", (message) => {
        if (message?.type !== "bridge:control" || !["string", "number"].includes(typeof message.id)) return;
        commands = commands.catch(() => {}).then(async () => {
          let response;
          try { response = { result: await control(message.action, message.data) }; }
          catch (error) { response = { error: error?.message ?? String(error) }; }
          if (channel.connected !== false) channel.send({ type: "bridge:control-result", id: message.id, ...response });
        });
      });
    },
  };
}
