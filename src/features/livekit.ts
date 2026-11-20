import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';

export interface LiveKitRoomConfig {
  roomName: string;
  emptyTimeout?: number;
  maxParticipants?: number;
}

export interface LiveKitTokenOptions {
  room: string;
  identity: string;
  name?: string;
  canPublish: boolean;
  canPublishData: boolean;
  canSubscribe: boolean;
  ttl?: number;
}

export async function createLiveKitRoom(config: LiveKitRoomConfig): Promise<void> {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LiveKit API credentials not configured');
  }

  const client = new RoomServiceClient(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL);
  try {
    await client.createRoom({
      name: config.roomName,
      emptyTimeout: config.emptyTimeout,
      maxParticipants: config.maxParticipants,
    });
    console.log('[LiveKit] Room created: %s', config.roomName);
  } catch (err) {
    if ((err as Error).message?.includes('already exists')) {
      console.log('[LiveKit] Room already exists: %s', config.roomName);
      return;
    }
    throw err;
  }
}

export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LiveKit API credentials not configured');
  }

  const client = new RoomServiceClient(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL);
  try {
    await client.deleteRoom(roomName);
    console.log('[LiveKit] Room deleted: %s', roomName);
  } catch (err) {
    console.warn('[LiveKit] Failed to delete room %s:', roomName, (err as Error).message);
  }
}

export async function createLiveKitToken(options: LiveKitTokenOptions): Promise<string> {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LiveKit API credentials not configured');
  }

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: options.identity,
    name: options.name,
    ttl: options.ttl,
  });

  const grant: any = {
    room: options.room,
    canPublish: options.canPublish,
    canPublishData: options.canPublishData ?? false,
    canSubscribe: options.canSubscribe ?? true,
  };
  token.addGrant(grant as any);

  return token.toJwt();
}

export async function verifyLiveKitWebhook(
  authHeader: string | undefined,
  rawBody: string | Buffer,
): Promise<{ event: string; payload: unknown } | null> {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('[LiveKit] Cannot verify webhook: API credentials not configured');
    return null;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('[LiveKit] Webhook missing or invalid Authorization header');
    return null;
  }

  const token = authHeader.split(' ')[1];

  try {
    const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString() : String(rawBody);
    const payload = await receiver.receive(body, token);
    return payload as unknown as { event: string; payload: unknown };
  } catch (err) {
    console.error('[LiveKit] Webhook verification failed:', (err as Error).message);
    return null;
  }
}
