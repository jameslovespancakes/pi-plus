import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { inboundText, parseSSE, RecentIds, record, type RemoteMessage } from "./protocol.ts";

const API = "https://api.anthropic.com";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE = 512;
const MAX_FRAME = 1024 * 1024;

type State = "idle" | "running";
type Operation =
  | { kind: "event"; json: string; bytes: number }
  | { kind: "state"; state: State }
  | { kind: "ack"; id: string }
  | { kind: "heartbeat" }
  | { kind: "refresh" };

interface Credentials {
  worker_jwt: string;
  api_base_url: string;
  expires_in: number;
  worker_epoch: number;
}

export interface BridgeOptions {
  getAccessToken(signal: AbortSignal): Promise<string>;
  title: string;
  trustedDeviceToken?: string;
  allowInbound: boolean;
  onText(text: string): void;
  onInterrupt(): void;
  onConnect(id: string): void;
  onConnectionChange?(connected: boolean): void;
  onError(message: string): void;
  /** Injected for offline protocol tests; production always uses native fetch. */
  fetch?: typeof fetch;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Claude Remote HTTP ${status}`);
    this.status = status;
  }
}

/** A single session, with no inference, auth persistence or model-context hooks.
 * Protocol adapted from clepdn/claude-remote-lib; see UPSTREAM.md.
 * All mutations (including epoch refresh) share one bounded, ordered writer.
 */
export class ClaudeRemoteBridge {
  private readonly options: BridgeOptions;
  private readonly fetcher: typeof fetch;
  private readonly lifetime = new AbortController();
  private stream?: AbortController;
  private heartbeat?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private credentials?: Credentials;
  private id?: string;
  private queue: Operation[] = [];
  private bytes = 0;
  private writing = false;
  private ready = false;
  private started = false;
  private state: State = "idle";
  private readonly seen = new RecentIds();
  private readonly posted = new RecentIds();

  constructor(options: BridgeOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
  }

  get sessionId(): string | undefined { return this.id; }
  get closed(): boolean { return this.lifetime.signal.aborted; }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      const token = await this.options.getAccessToken(this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      const response = await this.request(`${API}/v1/code/sessions`, token, "POST", {
        title: this.options.title, bridge: {}, tags: ["pi-plus"],
      });
      const data: unknown = await response.json();
      if (!record(data) || !record(data.session) || typeof data.session.id !== "string"
        || !/^cse_[\w-]+$/.test(data.session.id)) throw new Error("Invalid code session response");
      this.id = data.session.id;
      await this.refreshCredentials(token);
      if (this.closed) return;
      this.ready = true;
      this.heartbeat = setInterval(() => this.enqueue({ kind: "heartbeat" }), 20_000);
      this.heartbeat.unref();
      this.options.onConnect(this.id);
      this.drain();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Synchronous snapshots: pi can mutate its own messages after this returns. */
  send(message: RemoteMessage): void {
    if (this.closed) return;
    try {
      const uuid = randomUUID();
      const json = JSON.stringify({ ...message, uuid, parent_tool_use_id: null });
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_EVENT_BYTES) throw new Error("Remote message exceeds the 4 MiB limit");
      this.posted.add(uuid);
      this.enqueue({ kind: "event", json, bytes });
    } catch (error) { this.fail(error); }
  }

  reportState(state: State): void {
    this.state = state;
    this.enqueue({ kind: "state", state });
  }

  stop(): void {
    if (this.closed) return;
    this.lifetime.abort();
    this.stream?.abort();
    clearInterval(this.heartbeat);
    clearTimeout(this.refreshTimer);
    this.queue = [];
    this.bytes = 0;
    this.ready = false;
    this.credentials = undefined;
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.stop();
    // Never surface response bodies, URLs, OAuth errors, or arbitrary exception text.
    const reason = error instanceof HttpError ? error.message
      : error instanceof Error && /^(Remote message exceeds|Remote queue is full|Invalid code session|Invalid worker)/.test(error.message)
        ? error.message : "Claude Remote connection failed; check your Anthropic login and retry /claude-remote on";
    this.options.onError(reason);
  }

  private enqueue(operation: Operation): void {
    if (this.closed) return;
    if ((operation.kind === "heartbeat" || operation.kind === "refresh")
      && this.queue.some((item) => item.kind === operation.kind)) return;
    const bytes = operation.kind === "event" ? operation.bytes : 0;
    if (this.queue.length >= MAX_QUEUE || this.bytes + bytes > MAX_BYTES) {
      this.fail(new Error("Remote queue is full; mirroring stopped without affecting pi"));
      return;
    }
    this.queue.push(operation);
    this.bytes += bytes;
    this.drain();
  }

  private drain(): void {
    if (this.writing || !this.ready || this.closed) return;
    this.writing = true;
    void this.writeLoop().catch((error) => this.fail(error)).finally(() => {
      this.writing = false;
      if (!this.closed && this.queue.length) this.drain();
    });
  }

  private async writeLoop(): Promise<void> {
    while (!this.closed && this.queue.length) {
      const op = this.queue.shift()!;
      if (op.kind === "event") {
        const batch = [op];
        let size = op.bytes;
        while (batch.length < 50 && this.queue[0]?.kind === "event") {
          const next = this.queue[0];
          if (size + next.bytes > 512 * 1024) break;
          batch.push(this.queue.shift() as typeof op);
          size += next.bytes;
        }
        this.bytes -= size;
        await this.retry(() => this.worker("/events", "POST", {
          events: batch.map((item) => ({ payload: { ...JSON.parse(item.json), session_id: this.id } })),
        }));
      } else if (op.kind === "refresh") {
        await this.retry(() => this.refreshCredentials());
      } else if (op.kind === "state") {
        await this.retry(() => this.worker("", "PUT", { worker_status: op.state, external_metadata: {} }));
      } else if (op.kind === "heartbeat") {
        await this.retry(() => this.worker("/heartbeat", "POST", { session_id: this.id }));
      } else {
        await this.retry(() => this.worker("/events/delivery", "POST", {
          updates: [{ event_id: op.id, status: "processed" }],
        }));
      }
    }
  }

  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.lifetime.signal.throwIfAborted();
      try { return await work(); } catch (error) {
        if (this.closed || attempt >= 3 || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
        await delay(1000 * 2 ** attempt, undefined, { signal: this.lifetime.signal });
      }
    }
  }

  private async request(url: string, token: string, method: string, body: unknown, extra?: Record<string, string>): Promise<Response> {
    this.lifetime.signal.throwIfAborted();
    const response = await this.fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }
    return response;
  }

  private async worker(path: string, method: string, body: Record<string, unknown>): Promise<void> {
    const creds = this.credentials;
    if (!creds) throw new Error("Worker not connected");
    const response = await this.request(this.workerUrl(creds) + path, creds.worker_jwt, method,
      { ...body, worker_epoch: creds.worker_epoch });
    await response.body?.cancel();
  }

  private workerUrl(creds: Credentials): string {
    return `${creds.api_base_url.replace(/\/+$/, "")}/v1/code/sessions/${this.id}/worker`;
  }

  private async refreshCredentials(accessToken?: string): Promise<void> {
    const token = accessToken ?? await this.options.getAccessToken(this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    // A /bridge call invalidates the previous epoch. No writer runs concurrently.
    this.options.onConnectionChange?.(false);
    this.stream?.abort();
    const response = await this.request(`${API}/v1/code/sessions/${this.id}/bridge`, token, "POST", {},
      this.options.trustedDeviceToken ? { "X-Trusted-Device-Token": this.options.trustedDeviceToken } : undefined);
    const data: unknown = await response.json();
    if (!record(data) || typeof data.worker_jwt !== "string" || !data.worker_jwt
      || typeof data.api_base_url !== "string" || typeof data.expires_in !== "number"
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0
      || !(typeof data.worker_epoch === "number" || typeof data.worker_epoch === "string")
      || !Number.isSafeInteger(Number(data.worker_epoch)) || Number(data.worker_epoch) < 1) {
      throw new Error("Invalid worker credentials");
    }
    const url = new URL(data.api_base_url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid worker endpoint");
    }
    this.lifetime.signal.throwIfAborted();
    const credentials = { worker_jwt: data.worker_jwt, api_base_url: data.api_base_url,
      expires_in: data.expires_in, worker_epoch: Number(data.worker_epoch) };
    this.credentials = credentials;
    await this.worker("", "PUT", { worker_status: this.state, external_metadata: { pending_action: null, task_summary: null } });
    this.lifetime.signal.throwIfAborted();
    await this.openStream(credentials);
    this.lifetime.signal.throwIfAborted();
    clearTimeout(this.refreshTimer);
    // Five-minute headroom for ordinary TTLs; short TTLs refresh at 80% instead.
    const ttl = data.expires_in * 1000;
    const wait = Math.min(2_147_483_647, Math.max(1000, ttl - Math.min(300_000, ttl * 0.2)));
    this.refreshTimer = setTimeout(() => this.enqueue({ kind: "refresh" }), wait);
    this.refreshTimer.unref();
  }

  private async openStream(creds: Credentials): Promise<void> {
    const controller = new AbortController();
    this.stream = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    // Resolve on headers, not on EOF: heartbeat and refresh must run while SSE is open.
    const response = await this.fetchStream(creds, signal, 0);
    if (signal.aborted) {
      await response.body?.cancel();
      signal.throwIfAborted();
    }
    this.options.onConnectionChange?.(true);
    void this.readLoop(creds, response, signal).catch((error) => {
      if (!signal.aborted) this.fail(error);
    });
  }

  private async fetchStream(creds: Credentials, signal: AbortSignal, sequence: number): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 10_000);
    try {
      const url = new URL(this.workerUrl(creds) + "/events/stream");
      if (sequence > 0) url.searchParams.set("from_sequence_num", String(sequence));
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${creds.worker_jwt}`, "anthropic-version": "2023-06-01",
          Accept: "text/event-stream", "Cache-Control": "no-cache", "Last-Event-ID": String(sequence) },
        signal: AbortSignal.any([signal, timeout.signal]), redirect: "error",
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new HttpError(response.status);
      }
      return response;
    } finally { clearTimeout(timer); }
  }

  private async readLoop(creds: Credentials, initial: Response, signal: AbortSignal): Promise<void> {
    let response = initial;
    let sequence = 0;
    let failures = 0;
    while (!signal.aborted) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > MAX_FRAME) throw new Error("SSE frame too large");
          const parsed = parseSSE(buffer);
          buffer = parsed.remaining;
          for (const frame of parsed.frames) {
            let event: unknown;
            try { event = JSON.parse(frame); } catch { continue; }
            if (!record(event) || !record(event.payload)) continue;
            this.receive(event.payload, typeof event.event_id === "string" ? event.event_id : undefined);
            if (typeof event.sequence_num === "number" && Number.isSafeInteger(event.sequence_num)) {
              sequence = Math.max(sequence, event.sequence_num);
            }
            failures = 0;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.message === "SSE frame too large") throw error;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!signal.aborted) this.options.onConnectionChange?.(false);
      while (!signal.aborted) {
        if (++failures > 5) throw new Error("SSE reconnect exhausted");
        await delay(Math.min(1000 * 2 ** (failures - 1), 16_000), undefined, { signal });
        try {
          response = await this.fetchStream(creds, signal, sequence);
          if (!signal.aborted) this.options.onConnectionChange?.(true);
          break;
        } catch (error) {
          if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
        }
      }
    }
  }

  private receive(payload: Record<string, unknown>, eventId?: string): void {
    if (this.closed) return;
    const uuid = typeof payload.uuid === "string" ? payload.uuid : undefined;
    const key = uuid ? `uuid:${uuid}` : eventId ? `event:${eventId}` : undefined;
    if (!(key && this.seen.has(key)) && !(uuid && this.posted.has(uuid))) {
      if (payload.type === "control_request" && typeof payload.request_id === "string" && record(payload.request)) {
        this.control(payload.request_id, payload.request);
      } else if (this.options.allowInbound) {
        const text = inboundText(payload);
        if (text && text.length <= 128 * 1024) this.options.onText(text);
      }
      if (key) this.seen.add(key);
    }
    if (eventId) this.enqueue({ kind: "ack", id: eventId });
  }

  private control(id: string, request: Record<string, unknown>): void {
    let response: Record<string, unknown> = {};
    let error: string | undefined;
    switch (request.subtype) {
      case "initialize":
        response = { commands: [], output_style: "normal", available_output_styles: ["normal"], models: [], account: {}, pid: process.pid };
        break;
      case "interrupt":
        if (this.options.allowInbound) this.options.onInterrupt();
        else error = "This pi mirror is read-only";
        break;
      case "can_use_tool":
        response = { behavior: "deny", message: "Permissions are handled locally by pi" };
        break;
      default:
        // Unlike upstream, don't claim to switch pi's model or permissions when we haven't.
        error = "Change models, thinking and permissions in pi, not in the Claude app";
    }
    this.send({ type: "control_response", response: error
      ? { subtype: "error", request_id: id, error }
      : { subtype: "success", request_id: id, response } });
  }
}
