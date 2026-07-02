"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = void 0;
const projectRegistry_1 = require("../../registry/projectRegistry");
const storageRegistry_1 = require("../../registry/storageRegistry");
const storage_1 = require("../../providers/storage");
const contentAddress_1 = require("../../media/contentAddress");
const bus_1 = require("../../events/bus");
const queue_1 = require("../../jobs/queue");
const utils_1 = require("../../utils");
class StorageLayer {
    async upload(data) {
        const account = await projectRegistry_1.projectRegistry.findStorageAccount();
        if (!account)
            throw new Error('No active storage account');
        const id = (0, utils_1.generateId)();
        const provider = (0, storage_1.getStorageProvider)(account.provider);
        let buffer;
        if (data.buffer && typeof data.buffer === 'object') {
            buffer = Buffer.from(data.buffer);
        }
        else {
            buffer = Buffer.from('placeholder');
        }
        const { url } = await contentAddress_1.contentAddressing.deduplicate(buffer, () => provider.upload(`uploads/${id}`, buffer, data.mimeType || 'application/octet-stream'));
        await storageRegistry_1.storageRegistry.updateUsage(account.id, account.usedSpace + buffer.length);
        queue_1.jobQueue.enqueue('media.process', {
            id,
            path: `uploads/${id}`,
            mimeType: data.mimeType || 'application/octet-stream',
        });
        bus_1.eventBus.emit({
            type: 'media.uploaded',
            payload: { id, url, size: buffer.length },
            metadata: { timestamp: new Date(), source: 'storage-layer' },
        });
        return { url, id };
    }
    async delete(id) {
        const account = await projectRegistry_1.projectRegistry.findStorageAccount();
        if (!account)
            throw new Error('No active storage account');
        const provider = (0, storage_1.getStorageProvider)(account.provider);
        await provider.delete(id);
    }
    async move(id, targetProvider) {
        const provider = (0, storage_1.getStorageProvider)(targetProvider);
        await provider.move(id, targetProvider);
    }
}
exports.storage = new StorageLayer();
//# sourceMappingURL=index.js.map