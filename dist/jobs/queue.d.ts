import { Job } from './types';
type JobHandler = (job: Job) => Promise<void>;
declare class JobQueue {
    private queue;
    private handlers;
    private processing;
    private concurrency;
    constructor(concurrency?: number);
    register(jobType: string, handler: JobHandler): void;
    enqueue(type: string, payload: Record<string, unknown>, priority?: number): Job;
    private processNext;
    get length(): number;
}
export declare const jobQueue: JobQueue;
export {};
//# sourceMappingURL=queue.d.ts.map