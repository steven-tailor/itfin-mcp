export interface CdpPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** Opens a DevTools protocol connection to one browser target. */
export async function connectCdp(wsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Could not connect to the login browser.")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("The login browser was closed."));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}
