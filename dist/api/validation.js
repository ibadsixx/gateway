"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validation = void 0;
function validateRequest(req, res, next) {
    if (req.method === 'POST' || req.method === 'PUT') {
        if (!req.body || Object.keys(req.body).length === 0) {
            res.status(400).json({ error: 'Request body is required' });
            return;
        }
    }
    next();
}
const allowedDomains = new Set([
    'users', 'posts', 'comments', 'stories',
    'conversations', 'groups', 'pages', 'reports',
    'media', 'notifications',
]);
function validateDomain(domain) {
    return allowedDomains.has(domain);
}
function validateDomainMiddleware(req, res, next) {
    const { domain } = req.params;
    if (!validateDomain(domain)) {
        res.status(400).json({ error: `Unknown domain: ${domain}` });
        return;
    }
    next();
}
exports.validation = { validateRequest, validateDomain, validateDomainMiddleware };
//# sourceMappingURL=validation.js.map