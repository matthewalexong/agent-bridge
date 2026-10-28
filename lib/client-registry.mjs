// Which harness processes are attached to the bridge right now. The native
// host is the one long-lived process that sees every client, so it keeps this
// table, names the live clients in the side panel, and drops a client once its
// process is gone.
//
// Clients that send a pid are checked for liveness directly. Clients from older
// builds send no pid, so they can't be checked; they expire after a fixed time
// unless they identify again.

export const LEGACY_TTL_MS = 10 * 60_000;
export const LABEL_SEPARATOR = " · ";
export const MAX_LABEL_CHARS = 80;
const MAX_NAME_CHARS = 80;

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function createClientRegistry({
  isAlive = processIsAlive,
  now = Date.now,
  legacyTtlMs = LEGACY_TTL_MS,
} = {}) {
  // key -> { pid, name, identifiedAt }
  const clients = new Map();

  return {
    identify({ pid = null, agent } = {}) {
      const name = typeof agent === "string" ? agent.trim().slice(0, MAX_NAME_CHARS) : "";
      const key = pid != null ? `pid:${pid}` : `legacy:${name}`;
      if (!name) {
        // An empty identity withdraws this process's entry.
        if (pid != null) clients.delete(key);
        return;
      }
      clients.set(key, { pid, name, identifiedAt: now() });
    },

    detach(pid) {
      clients.delete(`pid:${pid}`);
    },

    // Removes clients whose process has exited or whose legacy entry is stale.
    // Returns true when anything was removed, so the caller knows to republish.
    prune() {
      let removed = false;
      for (const [key, client] of clients) {
        const gone = client.pid != null
          ? !isAlive(client.pid)
          : now() - client.identifiedAt >= legacyTtlMs;
        if (gone) {
          clients.delete(key);
          removed = true;
        }
      }
      return removed;
    },

    names() {
      return [...new Set([...clients.values()].map((client) => client.name))];
    },

    // The text the side panel shows, or null when no client is attached.
    label() {
      const names = this.names();
      if (names.length === 0) return null;
      const joined = names.join(LABEL_SEPARATOR);
      return joined.length > MAX_LABEL_CHARS ? `${joined.slice(0, MAX_LABEL_CHARS - 1)}…` : joined;
    },
  };
}
