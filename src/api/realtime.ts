import { Router, Request, Response } from 'express';
import { auth } from '../auth';
import { channelHub } from '../realtime/channelHub';

const realtimeRouter = Router();

const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// Public fallback TURN relay (Metered Open Relay). Override by setting
// TURN_URL / TURN_USERNAME / TURN_CREDENTIAL in the gateway .env.
const DEFAULT_TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

realtimeRouter.get('/ice-servers', auth.authenticate.bind(auth), (_req: Request, res: Response) => {
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  const turnServers = turnUrl && turnUsername && turnCredential
    ? [{ urls: turnUrl, username: turnUsername, credential: turnCredential }]
    : DEFAULT_TURN_SERVERS;
  res.json({ iceServers: [...DEFAULT_STUN_SERVERS, ...turnServers] });
});

const CALL_CHANNEL_RE = /^calls:[\w-]+$/;
const USER_CHANNEL_RE = /^user:[\w-]+$/;

function isCallChannel(channel: string): boolean {
  return CALL_CHANNEL_RE.test(channel);
}

function isUserChannel(channel: string): boolean {
  return USER_CHANNEL_RE.test(channel);
}

// Whether the given channel matches any supported realtime namespace.
function isValidChannel(channel: string): boolean {
  return isCallChannel(channel) || isUserChannel(channel);
}

// Debug endpoint — returns current hub state
realtimeRouter.get('/debug', (req: Request, res: Response) => {
  const debug: Record<string, unknown> = {};
  const channels = (channelHub as any).channels as Map<string, Map<string, unknown>> | undefined;
  if (channels) {
    const channelState: Record<string, number> = {};
    for (const [ch, subs] of channels) {
      channelState[ch] = subs.size;
    }
    debug.subscribers = channelState;
  }
  debug.hasBus = !!(channelHub as any).bus;
  debug.hasSupabase = !!(channelHub as any).supabase;
  res.json(debug);
});

realtimeRouter.get('/subscribe/:channel', auth.authenticate.bind(auth), (req: Request, res: Response) => {
  const channel = req.params.channel || '';
  console.log(`[Realtime] SUBSCRIBE request: channel=${channel} user=${req.user?.id}`);
  if (!channel) {
    res.status(400).json({ error: 'Channel is required' });
    return;
  }
  if (!isValidChannel(channel)) {
    console.warn(`[Realtime] SUBSCRIBE rejected: invalid channel format: ${channel}`);
    res.status(400).json({ error: 'Invalid channel format' });
    return;
  }

  // Security: a user may only subscribe to their own signaling channel.
  // Otherwise any authenticated client could read (and spoof) another user's
  // call signaling by subscribing to calls:<theirId>.
  if (channel !== `calls:${req.user?.id}` && channel !== `user:${req.user?.id}`) {
    console.warn(`[Realtime] SUBSCRIBE rejected: channel ${channel} does not match user ${req.user?.id}`);
    res.status(403).json({ error: 'You may only subscribe to your own channel' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const connId = channelHub.subscribe(channel, res);
  console.log(`[Realtime] SUBSCRIBE OK: channel=${channel} connId=${connId} user=${req.user?.id}`);
  res.write(`event: init\ndata: ${JSON.stringify({ connId })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(heartbeat);
      channelHub.unsubscribe(channel, connId);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    channelHub.unsubscribe(channel, connId);
    console.log(`[Realtime] SUBSCRIBE closed: channel=${channel} connId=${connId}`);
  });
});

realtimeRouter.post('/publish', auth.authenticate.bind(auth), (req: Request, res: Response) => {
  const { channel, event, payload, excludeConnId } = req.body || {};
  console.log(`[Realtime] PUBLISH request: channel=${channel} event=${event} user=${req.user?.id} exclude=${excludeConnId || 'none'}`);
  console.log(`[Realtime] PUBLISH body keys: ${Object.keys(req.body || {}).join(', ')} body type: ${typeof req.body}`);
  if (typeof channel !== 'string' || !channel || !isValidChannel(channel)) {
    console.warn(`[Realtime] PUBLISH rejected: invalid channel: "${channel}"`);
    res.status(400).json({ error: 'channel must be a valid calls/user channel' });
    return;
  }
  if (typeof event !== 'string' || !event) {
    console.warn(`[Realtime] PUBLISH rejected: invalid event: "${event}"`);
    res.status(400).json({ error: 'event is required' });
    return;
  }
  const delivered = channelHub.publish(
    channel,
    event,
    payload,
    typeof excludeConnId === 'string' ? excludeConnId : undefined
  );
  console.log(`[Realtime] PUBLISH result: channel=${channel} event=${event} delivered=${delivered}`);
  res.status(200).json({ ok: true, delivered });
});

export { realtimeRouter };
