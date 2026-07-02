export interface Post {
  id: string;
  userId: string;
  content: string;
  mediaIds: string[];
  createdAt: Date;
  updatedAt: Date;
}
