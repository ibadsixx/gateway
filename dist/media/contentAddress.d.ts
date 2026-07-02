declare class ContentAddressing {
    private store;
    address(buffer: Buffer): Promise<string>;
    deduplicate(buffer: Buffer, uploadFn: () => Promise<{
        url: string;
        id: string;
    }>): Promise<{
        url: string;
        id: string;
    }>;
    isStored(hash: string): boolean;
}
export declare const contentAddressing: ContentAddressing;
export {};
//# sourceMappingURL=contentAddress.d.ts.map