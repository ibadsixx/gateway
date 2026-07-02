"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudinaryProvider = void 0;
class CloudinaryProvider {
    async upload(path, _buffer, mimeType) {
        console.log(`[Cloudinary] Uploading ${path} (${mimeType})`);
        return { url: `https://res.cloudinary.com/tone/${path}`, id: crypto.randomUUID() };
    }
    async delete(id) {
        console.log(`[Cloudinary] Deleting ${id}`);
    }
    async move(id, destination) {
        console.log(`[Cloudinary] Moving ${id} to ${destination}`);
    }
    async copy(id, destination) {
        console.log(`[Cloudinary] Copying ${id} to ${destination}`);
    }
}
exports.CloudinaryProvider = CloudinaryProvider;
//# sourceMappingURL=cloudinaryProvider.js.map