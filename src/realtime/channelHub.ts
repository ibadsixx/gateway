import { Response } from 'express';

interface Subscriber {
  connId: string;
  res: Response;
  channel: string;
}

// In-memory SSE fan-out hub for call signaling (and other realtime channels).
// Connections live only for the lifetime of the gateway process, which matches
// how the gateway is run as a single long-lived server (see src/dev.ts).
class ChannelHub {
  private channels = new Map<string, Map<string, Subscriber>>();
  private counter = 0;

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
    const subs = this.channels.get(channel);
    if (!subs) return 0;
    const data = JSON.stringify({ event, payload });
    let delivered = 0;
    for (const [connId, sub] of subs) {
      if (excludeConnId && connId === excludeConnId) continue;
      if (this.send(sub, 'message', data)) delivered++;
    }
    return delivered;
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

export const channelHub = new ChannelHub();
