"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = void 0;
class AuthService {
    async authenticate(req, _res, next) {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            _res.status(401).json({ error: 'Authentication required' });
            return;
        }
        next();
    }
    async verifyToken(token) {
        return { userId: 'user-id' };
    }
}
exports.auth = new AuthService();
//# sourceMappingURL=index.js.map