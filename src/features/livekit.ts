import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';

export function createLiveKitRoom(name: string): Promise<void> {
  return Promise.resolve();
}

export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  return Promise.resolve();
}

export function createLiveKitToken(room: string, identity: string): string {
  return '';
}

export function verifyLiveKitWebhook(authHeader: string | undefined, rawBody: string | Buffer): { event: string; payload: unknown } | null {
  return null;
}

export const LIVEKIT_API_KEY = '';
export const LIVEKIT_API_SECRET = '';
export const LIVEKIT_URL = 'ws://localhost:7880';