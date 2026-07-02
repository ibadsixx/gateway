"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentAddressing = void 0;
const crypto_1 = require("crypto");
class ContentAddressing {
    store = new Map();
    async address(buffer) {
        return (0, crypto_1.createHash)('sha256').update(buffer).digest('hex');
    }
    async deduplicate(buffer, uploadFn) {
        const hash = await this.address(buffer);
        const existing = this.store.get(hash);
        if (existing) {
            console.log(`[ContentAddress] Reusing existing file with hash ${hash.substring(0, 12)}...`);
            return existing;
        }
        const result = await uploadFn();
        this.store.set(hash, result);
        return result;
    }
    isStored(hash) {
        return this.store.has(hash);
    }
}
exports.contentAddressing = new ContentAddressing();
//# sourceMappingURL=contentAddress.js.map