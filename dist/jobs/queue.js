"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobQueue = void 0;
const utils_1 = require("../utils");
class JobQueue {
    queue = [];
    handlers = new Map();
    processing = false;
    concurrency;
    constructor(concurrency = 4) {
        this.concurrency = concurrency;
    }
    register(jobType, handler) {
        this.handlers.set(jobType, handler);
    }
    enqueue(type, payload, priority = 0) {
        const job = {
            id: (0, utils_1.generateId)(),
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
    async processNext() {
        if (this.processing)
            return;
        this.processing = true;
        while (this.queue.length > 0) {
            const job = this.queue.shift();
            const handler = this.handlers.get(job.type);
            if (!handler) {
                console.warn(`No handler for job type: ${job.type}`);
                continue;
            }
            job.status = 'RUNNING';
            try {
                await handler(job);
                job.status = 'COMPLETED';
            }
            catch (error) {
                job.retries++;
                if (job.retries <= job.maxRetries) {
                    job.status = 'PENDING';
                    this.queue.push(job);
                }
                else {
                    job.status = 'FAILED';
                    console.error(`Job ${job.id} failed after ${job.maxRetries} retries`, error);
                }
            }
            job.updatedAt = new Date();
        }
        this.processing = false;
    }
    get length() {
        return this.queue.length;
    }
}
exports.jobQueue = new JobQueue();
//# sourceMappingURL=queue.js.map