export interface RequestFileLimits {
    /** Absolute (or `~`-prefixed) directories a request file may be read from. Empty disables the feature. */
    allowedRoots: string[];
    /** Hard cap on file size. */
    maxBytes: number;
}
export type RequestFileRejection = "disabled" | "not_absolute" | "outside_allowed_roots" | "not_found" | "not_a_file" | "too_large" | "binary" | "empty" | "denied_name" | "unreadable";
export type RequestFileResult = {
    ok: true;
    text: string;
    bytes: number;
    resolvedPath: string;
} | {
    ok: false;
    code: RequestFileRejection;
    message: string;
};
export declare function expandHome(p: string): string;
/**
 * True when `candidate` is the root itself or sits beneath it. Compares on path
 * segments so `/srv/briefs-secret` does not match a `/srv/briefs` root.
 */
export declare function isInsideRoot(candidate: string, root: string): boolean;
interface FsLike {
    realpathSync: (p: string) => string;
    statSync: (p: string) => {
        isFile: () => boolean;
        size: number;
    };
    readFileSync: (p: string, enc: "utf8") => string;
}
/**
 * Read a user specification from disk, refusing anything that is not plainly a
 * brief sitting in an allowed location.
 */
export declare function readRequestFile(rawPath: string, limits: RequestFileLimits, fs?: FsLike): RequestFileResult;
export interface ParaphraseDrift {
    /** Bytes of the authoritative on-disk spec. */
    fileBytes: number;
    /** Bytes of the `request` string the caller ALSO supplied. */
    paraphraseBytes: number;
    /** paraphraseBytes / fileBytes, rounded to 2dp. */
    ratio: number;
    /** Distinctive spec tokens present on disk but absent from the paraphrase. */
    droppedTerms: string[];
    /** True when the paraphrase is materially smaller or lost identifiers. */
    material: boolean;
}
/**
 * Compare a caller-supplied paraphrase against the authoritative file so the
 * audit log records, in numbers, that a paraphrase was offered and discarded.
 * Purely observational -- the file always wins.
 */
export declare function measureParaphraseDrift(fileText: string, paraphrase: string): ParaphraseDrift;
export {};
//# sourceMappingURL=brief-source.d.ts.map