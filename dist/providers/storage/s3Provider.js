"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3Provider = void 0;
class S3Provider {
    async upload(path, _buffer, mimeType) {
        console.log(`[AWS S3] Uploading ${path} (${mimeType})`);
        return { url: `https://s3.amazonaws.com/tone/${path}`, id: crypto.randomUUID() };
    }
    async delete(id) {
        console.log(`[AWS S3] Deleting ${id}`);
    }
    async move(id, destination) {
        console.log(`[AWS S3] Moving ${id} to ${destination}`);
    }
    async copy(id, destination) {
        console.log(`[AWS S3] Copying ${id} to ${destination}`);
    }
}
exports.S3Provider = S3Provider;
//# sourceMappingURL=s3Provider.js.map