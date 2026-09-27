import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { type AgentInfo, type Config, type Coordination, type Listener } from "./types.ts";
import { cleanLine } from "./format.ts";

const HEARTBEAT_MS = 8_000;

const REQUEST_TIMEOUT_MS = 2_000;

export class BoardClient {
  private ws?: WebSocket;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempts = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private agent?: AgentInfo;
  connected = false;
  coordination: Coordination = {};

  constructor(private readonly config: Config) {}
  start(agent: AgentInfo): void { this.agent = agent; this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true; this.connected = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, "pi session shutdown"); this.ws = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Agent board disconnected")); }
    this.pending.clear();
  }
  on(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: any): void { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  private connect(): void {
    if (this.stopped || !this.agent) return;
    const ws = new WebSocket(this.config.url);
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ t: "register", token: this.config.token, agent: this.agent })));
    ws.on("message", (raw) => {
      let value: any; try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value.t === "registered") {
        this.connected = true; this.attempts = 0;
        this.coordination = { key: value.key, coordinator: value.coordinator, reports: value.reports, repoThread: value.repoThread };
        this.emit({ t: "connection", connected: true });
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.presence({}), HEARTBEAT_MS); this.heartbeat.unref?.();
      } else if (value.t === "coordination") {
        this.coordination = { ...this.coordination, key: value.key, coordinator: value.coordinator, reports: value.reports };
        this.emit(value);
      } else if (value.t === "thread") {
        this.emit(value);
      } else if (value.t === "res") {
        const item = this.pending.get(value.id); if (!item) return;
        this.pending.delete(value.id); clearTimeout(item.timer);
        if (value.ok) item.resolve(value.data);
        else item.reject(new Error(value.error || "Board request failed"));
      } else if (value.t === "message") this.emit(value);
    });
    const disconnected = () => {
      if (this.ws !== ws) return;
      this.connected = false; this.emit({ t: "connection", connected: false });
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) {
        const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts++, 5));
        this.reconnect = setTimeout(() => this.connect(), delay); this.reconnect.unref?.();
      }
    };
    ws.once("close", disconnected); ws.once("error", disconnected);
  }
  presence(patch: Partial<AgentInfo>): void {
    if (!this.agent) return;
    this.agent = { ...this.agent, ...patch };
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) this.ws.send(JSON.stringify({ t: "presence", agent: patch }));
  }
  activity(type: string, summary: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) this.ws.send(JSON.stringify({ t: "activity", event: { type, summary: cleanLine(summary), at: Date.now() } }));
  }
  request(action: string, input: Record<string, unknown> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<any> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Agent board is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Agent board request timed out")); }, timeout);
      timer.unref?.(); this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ t: "req", id, action, ...input }));
    });
  }
}
