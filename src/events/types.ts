export interface Event {
  type: string;
  payload: Record<string, unknown>;
  metadata: {
    timestamp: Date;
    source: string;
    correlationId?: string;
  };
}
