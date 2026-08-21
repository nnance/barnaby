import { isState, type StateName } from './expressions';

/**
 * Messages from the Pi orchestrator. This is a network boundary, so everything
 * is validated at runtime — a typo in the orchestrator should log and be
 * ignored, never throw and take the face down.
 */
export type Inbound =
  | { type: 'state'; name: StateName }
  | { type: 'look'; x: number; y: number }
  | { type: 'ping' };

export interface TransportHandlers {
  onState(name: StateName): void;
  onLook(x: number, y: number): void;
  onOpen(): void;
  onClose(): void;
}

function parse(raw: string): Inbound | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'state':
      return isState(m.name) ? { type: 'state', name: m.name } : null;
    case 'look':
      return typeof m.x === 'number' && typeof m.y === 'number'
        ? { type: 'look', x: m.x, y: m.y } : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

export class Transport {
  private ws: WebSocket | null = null;
  private backoff = 250;
  private readonly maxBackoff = 5000;
  private timer = 0;
  private stopped = false;

  constructor(private url: string, private h: TransportHandlers) {}

  connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = 250;
      this.h.onOpen();
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      const msg = parse(ev.data);
      if (!msg) { console.warn('[face] ignored malformed message', ev.data); return; }
      if (msg.type === 'state') this.h.onState(msg.name);
      else if (msg.type === 'look') this.h.onLook(msg.x, msg.y);
    });

    const retry = () => {
      this.h.onClose();
      this.ws = null;
      if (this.stopped) return;
      // The face must survive the orchestrator restarting. It shows its last
      // state and keeps blinking rather than going black.
      this.timer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => ws.close());
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
