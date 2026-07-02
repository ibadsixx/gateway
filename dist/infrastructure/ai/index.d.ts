interface ModerationResult {
    approved: boolean;
    flags: string[];
    score: number;
}
declare class AILayer {
    moderateText(content: string): Promise<ModerationResult>;
    moderateImage(url: string): Promise<ModerationResult>;
    detectSpam(content: string): Promise<boolean>;
}
export declare const ai: AILayer;
export {};
//# sourceMappingURL=index.d.ts.map