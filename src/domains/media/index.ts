export interface Media {
  id: string;
  url: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  size: number;
  uploadedBy: string;
  createdAt: Date;
}
