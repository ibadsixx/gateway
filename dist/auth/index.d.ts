import { Request, Response, NextFunction } from 'express';
declare class AuthService {
    authenticate(req: Request, _res: Response, next: NextFunction): Promise<void>;
    verifyToken(token: string): Promise<{
        userId: string;
    } | null>;
}
export declare const auth: AuthService;
export {};
//# sourceMappingURL=index.d.ts.map