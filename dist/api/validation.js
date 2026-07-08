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
function validateDomain(domain) {
    return typeof domain === 'string' && domain.length > 0 && /^[a-z][a-z0-9_-]*$/.test(domain);
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