"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateId = generateId;
exports.sleep = sleep;
exports.env = env;
function generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}${random}`;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function env(key, defaultValue) {
    return process.env[key] || defaultValue || '';
}
//# sourceMappingURL=index.js.map