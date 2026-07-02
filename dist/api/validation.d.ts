import { Request, Response, NextFunction } from 'express';
declare function validateRequest(req: Request, res: Response, next: NextFunction): void;
declare function validateDomain(domain: string): boolean;
declare function validateDomainMiddleware(req: Request, res: Response, next: NextFunction): void;
export declare const validation: {
    validateRequest: typeof validateRequest;
    validateDomain: typeof validateDomain;
    validateDomainMiddleware: typeof validateDomainMiddleware;
};
export {};
//# sourceMappingURL=validation.d.ts.map