export interface MediaPipelineTask {
    id: string;
    buffer: Buffer;
    mimeType: string;
    path: string;
    steps: MediaPipelineStep[];
}
export type MediaPipelineStep = 'VIRUS_SCAN' | 'COMPRESSION' | 'THUMBNAIL' | 'AI_MODERATION' | 'STORAGE' | 'DATABASE';
declare class MediaPipeline {
    process(task: MediaPipelineTask): Promise<string>;
    private virusScan;
    private compress;
    private generateThumbnail;
    private moderate;
    private store;
    private saveMetadata;
}
export declare const mediaPipeline: MediaPipeline;
export {};
//# sourceMappingURL=pipeline.d.ts.map