import { createHash } from 'crypto';
import { StorageProvider, UploadResult, UploadCredentials, StorageQuotaError } from './types';

const FULL_MESSAGE_PATTERN = /quota|full|capacity|exceeded|storage limit/i;

function signParams(params: Record<string, string>, apiSecret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(`${canonical}${apiSecret}`).digest('hex');
}

export interface SignedUploadParams {
  uploadUrl: string;
  cloudName: string;
  apiKey: string;
  timestamp: string;
  folder: string;
  publicId: string;
  signature: string;
}

export class CloudinaryProvider implements StorageProvider {
  // Produce the parameters a browser needs to POST a file straight to
  // Cloudinary (https://api.cloudinary.com/v1_1/:cloud/auto/upload). Vercel
  // caps serverless request bodies (~4.5MB on Hobby), so proxying whole video
  // files through the gateway aborts before the function runs and the browser
  // sees TypeError: Failed to fetch. The gateway stays the auth + signing
  // choke point and only hands back a short-lived signed upload URL.
  createSignedUploadParams(path: string, credentials?: UploadCredentials): SignedUploadParams {
    const { cloudName, apiKey, apiSecret } = credentials || {};
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error('Cloudinary account credentials missing (cloud_name, api_key, api_secret)');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'tone';
    const params = { timestamp: String(timestamp), folder, public_id: path };
    const signature = signParams(params, apiSecret);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
      cloudName,
      apiKey: String(apiKey),
      timestamp: String(timestamp),
      folder,
      publicId: path,
      signature,
    };
  }
  async upload(path: string, buffer: Buffer, mimeType: string, credentials?: UploadCredentials): Promise<UploadResult> {
    const { cloudName, apiKey, apiSecret } = credentials || {};
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error('Cloudinary account credentials missing (cloud_name, api_key, api_secret)');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      timestamp: String(timestamp),
      folder: 'tone',
      public_id: path,
    };
    const signature = signParams(params, apiSecret);

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), path.split('/').pop() || 'upload');
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('folder', params.folder);
    form.append('public_id', params.public_id);
    form.append('signature', signature);

    const url = `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`;
    const res = await fetch(url, { method: 'POST', body: form });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (json as any)?.error?.message || `Cloudinary upload failed (${res.status})`;
      if (res.status === 420 || FULL_MESSAGE_PATTERN.test(message)) {
        throw new StorageQuotaError(message);
      }
      throw new Error(message);
    }

    return {
      url: (json as any).secure_url as string,
      id: (json as any).public_id as string,
    };
  }

  async delete(id: string): Promise<void> {
    console.log(`[Cloudinary] Deleting ${id}`);
  }

  async move(id: string, destination: string): Promise<void> {
    console.log(`[Cloudinary] Moving ${id} to ${destination}`);
  }

  async copy(id: string, destination: string): Promise<void> {
    console.log(`[Cloudinary] Copying ${id} to ${destination}`);
  }
}
