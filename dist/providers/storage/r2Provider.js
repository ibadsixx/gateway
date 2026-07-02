"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.R2Provider = void 0;
class R2Provider {
    async upload(path, _buffer, mimeType) {
        console.log(`[Cloudflare R2] Uploading ${path} (${mimeType})`);
        return { url: `https://r2.cloudflarestorage.com/tone/${path}`, id: crypto.randomUUID() };
    }
    async delete(id) {
        console.log(`[Cloudflare R2] Deleting ${id}`);
    }
    async move(id, destination) {
        console.log(`[Cloudflare R2] Moving ${id} to ${destination}`);
    }
    async copy(id, destination) {
        console.log(`[Cloudflare R2] Copying ${id} to ${destination}`);
    }
}
exports.R2Provider = R2Provider;
//# sourceMappingURL=r2Provider.js.map