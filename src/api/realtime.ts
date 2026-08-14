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

realtimeRouter.get('/subscribe/:channel', auth.authenticate.bind(auth), (req: Request, res: Response) => {
  const channel = req.params.channel || '';
  if (!channel) {
    res.status(400).json({ error: 'Channel is required' });
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
  });
});

realtimeRouter.post('/publish', auth.authenticate.bind(auth), (req: Request, res: Response) => {
  const { channel, event, payload, excludeConnId } = req.body || {};
  if (typeof channel !== 'string' || !channel || typeof event !== 'string' || !event) {
    res.status(400).json({ error: 'channel and event are required' });
    return;
  }
  const delivered = channelHub.publish(
    channel,
    event,
    payload,
    typeof excludeConnId === 'string' ? excludeConnId : undefined
  );
  res.status(200).json({ ok: true, delivered });
});

export { realtimeRouter };
