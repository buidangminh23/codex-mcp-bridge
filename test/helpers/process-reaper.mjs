export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let alive = [...pids].filter(processAlive);
  while (alive.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = alive.filter(processAlive);
  }
  return alive;
}

export function createProcessReaper() {
  const pids = new Set();
  return {
    pids,
    track(...values) {
      for (const pid of values) if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    },
    async reap(timeoutMs = 10000) {
      const leaked = await waitForExit(pids, timeoutMs);
      for (const pid of leaked) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await waitForExit(leaked, 5000);
      return leaked;
    },
  };
}
