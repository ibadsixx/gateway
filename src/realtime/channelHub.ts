import { Response } from 'express';
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

interface Subscriber {
  connId: string;
  res: Response;
  channel: string;
}

const INFRA_SUPABASE_URL = process.env.INFRA_SUPABASE_URL;
const INFRA_SUPABASE_KEY = process.env.INFRA_SUPABASE_KEY;

// Shared Realtime channel used to relay signals across gateway instances.
// Every gateway instance joins this one channel at startup, so a publish from
// any instance reaches the SSE subscribers attached to every other instance.
const BUS_CHANNEL = 'tone-gateway-broadcast';

// In-memory SSE fan-out hub for call signaling (and other realtime channels).
//
// The hub relays every publish through the infra Supabase project's Realtime
// bus. On Vercel each serverless lambda has its own process/memory, so an
// in-memory map alone could never deliver a caller's publish to the callee's
// SSE connection when they land on different instances. With the bus, a
// publish is delivered to local subscribers immediately and echoed to the
// shared channel so the other instances forward it to their local
// subscribers. If the bus is unavailable (missing env vars, no WebSocket, or
// the infra project's Realtime is unreachable), the hub degrades to local-only
// delivery, which still matches how the gateway runs as a single long-lived
// server (see src/dev.ts).
class ChannelHub {
  private channels = new Map<string, Map<string, Subscriber>>();
  private bus: RealtimeChannel | null = null;
  private supabase: SupabaseClient | null = null;
  private counter = 0;

  constructor() {
    if (!INFRA_SUPABASE_URL || !INFRA_SUPABASE_KEY) {
      console.warn('[Realtime] INFRA_SUPABASE_URL/INFRA_SUPABASE_KEY not set — cross-instance delivery disabled');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      console.warn('[Realtime] No WebSocket in this runtime — cross-instance delivery disabled');
      return;
    }
    try {
      this.supabase = createClient(INFRA_SUPABASE_URL, INFRA_SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      this.joinBus();
    } catch (err) {
      console.error('[Realtime] Failed to create infra bus client:', (err as Error).message);
      this.supabase = null;
    }
  }

  subscribe(channel: string, res: Response): string {
    const connId = `${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Map();
      this.channels.set(channel, subs);
    }
    subs.set(connId, { connId, res, channel });
    return connId;
  }

  unsubscribe(channel: string, connId: string): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    subs.delete(connId);
    if (subs.size === 0) this.channels.delete(channel);
  }

  publish(channel: string, event: string, payload: unknown, excludeConnId?: string): number {
    let delivered = 0;
    const subs = this.channels.get(channel);
    if (subs) {
      const data = JSON.stringify({ event, payload });
      for (const [connId, sub] of subs) {
        if (excludeConnId && connId === excludeConnId) continue;
        if (this.send(sub, 'message', data)) delivered++;
      }
    }
    const hasBus = !!(this.supabase && this.bus);
    this.relay(channel, event, payload);
    if (!hasBus && delivered === 0) {
      console.warn(`[Realtime] publish ${event}→${channel}: 0 local subscribers, no bus — message lost`);
    }
    return delivered;
  }

  private joinBus(): void {
    if (!this.supabase || this.bus) return;
    try {
      const bus = this.supabase.channel(BUS_CHANNEL, {
        config: { broadcast: { self: false } },
      });
      bus.on('broadcast', { event: '*' }, (envelope) => {
        this.deliverFromBus(envelope as unknown as BusEnvelope);
      });
      bus.subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`[Realtime] Bus channel status: ${status} — cross-instance delivery degraded`);
        } else if (status === 'SUBSCRIBED') {
          console.log('[Realtime] Bus channel subscribed — cross-instance delivery active');
        }
      });
      this.bus = bus;
    } catch (err) {
      console.error('[Realtime] Failed to join bus:', (err as Error).message);
      this.bus = null;
    }
  }

  private relay(channel: string, event: string, payload: unknown): void {
    if (!this.supabase || !this.bus) return;
    try {
      this.bus.send({
        type: 'broadcast',
        event: `relay:${channel}`,
        payload: { channel, event, payload },
      });
    } catch (err) {
      console.error('[Realtime] Bus relay failed:', (err as Error).message);
    }
  }

  private deliverFromBus(envelope: BusEnvelope): void {
    // Supabase broadcast callback gives { event, payload, type }.
    // relay() packed { channel, event, payload } as the payload object.
    // Depending on the Supabase JS client version the callback may receive
    // the full envelope ({ event, payload, type }) or just the payload.
    // Handle both structures:
    //   v2: envelope.payload = { channel, event, payload }
    //   v1: envelope         = { channel, event, payload } (no wrapper)
    const raw = (envelope as unknown as Record<string, unknown>);
    let inner: BusEnvelope | undefined;
    if (raw && typeof raw === 'object' && 'payload' in raw && typeof (raw as any).payload === 'object') {
      inner = (raw as any).payload as BusEnvelope;
    } else {
      inner = raw as unknown as BusEnvelope;
    }
    const { channel, event, payload } = inner || {};
    if (!channel || !event) {
      console.warn('[Realtime] deliverFromBus: malformed bus message — channel/event missing, dropping');
      return;
    }
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) {
      console.warn(`[Realtime] deliverFromBus: no local subscribers for ${channel} — message dropped`);
      return;
    }
    const data = JSON.stringify({ event, payload });
    let delivered = 0;
    for (const sub of subs.values()) {
      if (this.send(sub, 'message', data)) delivered++;
    }
    console.log(`[Realtime] deliverFromBus: ${event}→${channel} delivered to ${delivered}/${subs.size} local subscriber(s)`);
  }

  private send(sub: Subscriber, event: string, data: string): boolean {
    try {
      sub.res.write(`event: ${event}\ndata: ${data}\n\n`);
      return true;
    } catch {
      this.unsubscribe(sub.channel, sub.connId);
      return false;
    }
  }
}

interface BusEnvelope {
  channel: string;
  event: string;
  payload: unknown;
}

export const channelHub = new ChannelHub();
