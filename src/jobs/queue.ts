import { Job } from './types';
import { generateId } from '../utils';

type JobHandler = (job: Job) => Promise<void>;

class JobQueue {
  private queue: Job[] = [];
  private handlers: Map<string, JobHandler> = new Map();
  private processing = false;
  private concurrency: number;

  constructor(concurrency = 4) {
    this.concurrency = concurrency;
  }

  register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  enqueue(type: string, payload: Record<string, unknown>, priority = 0): Job {
    const job: Job = {
      id: generateId(),
      type,
      payload,
      priority,
      retries: 0,
      maxRetries: 3,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.processNext();
    return job;
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      const handler = this.handlers.get(job.type);
      if (!handler) {
        console.warn(`No handler for job type: ${job.type}`);
        continue;
      }

      job.status = 'RUNNING';
      try {
        await handler(job);
        job.status = 'COMPLETED';
      } catch (error) {
        job.retries++;
        if (job.retries <= job.maxRetries) {
          job.status = 'PENDING';
          this.queue.push(job);
        } else {
          job.status = 'FAILED';
          console.error(`Job ${job.id} failed after ${job.maxRetries} retries`, error);
        }
      }
      job.updatedAt = new Date();
    }

    this.processing = false;
  }

  get length(): number {
    return this.queue.length;
  }
}

export const jobQueue = new JobQueue();
