"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.middleware = middleware;
const express_1 = require("express");
const cors_1 = __importDefault(require("cors"));
const rate_limiting_1 = require("../rate-limiting");
const audit_1 = require("../audit");
const metrics_1 = require("../metrics");
function middleware(app) {
    app.use((0, cors_1.default)());
    app.use((0, express_1.json)({ limit: '10mb' }));
    app.use((0, express_1.urlencoded)({ extended: true }));
    rate_limiting_1.rateLimiter.define('*', { windowMs: 60000, maxRequests: 1000 });
    rate_limiting_1.rateLimiter.define('POST /comments', { windowMs: 60000, maxRequests: 100 });
    app.use((req, res, next) => {
        res.setHeader('X-Gateway', 'Tone-API-Gateway');
        res.setHeader('X-API-Version', 'v1');
        const key = req.ip || 'unknown';
        const endpoint = `${req.method} ${req.path}`;
        if (!rate_limiting_1.rateLimiter.check(endpoint, key)) {
            metrics_1.metricsService.increment('rate_limit.exceeded', { endpoint });
            res.status(429).json({ error: 'Too many requests' });
            return;
        }
        const start = Date.now();
        const originalEnd = res.end.bind(res);
        res.end = function (...args) {
            const duration = Date.now() - start;
            metrics_1.metricsService.record('request.duration', duration, { method: req.method, path: req.path });
            audit_1.auditLogger.log({
                userId: req.userId || 'anonymous',
                action: `${req.method} ${req.path}`,
                resource: req.path,
                resourceId: req.params?.id,
                ip: req.ip || '',
                duration,
                status: res.statusCode < 400 ? 'SUCCESS' : 'FAILURE',
            });
            return originalEnd(...args);
        };
        next();
    });
    app.use((err, _req, res, _next) => {
        console.error('[Error]', err.message);
        metrics_1.metricsService.increment('error.unhandled', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
    });
}
//# sourceMappingURL=middleware.js.map