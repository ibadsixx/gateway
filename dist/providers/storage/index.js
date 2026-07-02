"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.R2Provider = exports.S3Provider = exports.CloudinaryProvider = void 0;
exports.getStorageProvider = getStorageProvider;
const cloudinaryProvider_1 = require("./cloudinaryProvider");
Object.defineProperty(exports, "CloudinaryProvider", { enumerable: true, get: function () { return cloudinaryProvider_1.CloudinaryProvider; } });
const s3Provider_1 = require("./s3Provider");
Object.defineProperty(exports, "S3Provider", { enumerable: true, get: function () { return s3Provider_1.S3Provider; } });
const r2Provider_1 = require("./r2Provider");
Object.defineProperty(exports, "R2Provider", { enumerable: true, get: function () { return r2Provider_1.R2Provider; } });
const providers = {
    cloudinary: new cloudinaryProvider_1.CloudinaryProvider(),
    s3: new s3Provider_1.S3Provider(),
    r2: new r2Provider_1.R2Provider(),
};
function getStorageProvider(name) {
    const provider = providers[name];
    if (!provider) {
        throw new Error(`Unknown storage provider: ${name}`);
    }
    return provider;
}
//# sourceMappingURL=index.js.map