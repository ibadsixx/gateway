export interface Story {
  id: string;
  userId: string;
  mediaIds: string[];
  expiresAt: Date;
  createdAt: Date;
}
