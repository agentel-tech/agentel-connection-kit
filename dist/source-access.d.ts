/** Source access is a transport observation, never a fact check or a bypass tool. */
export type SourceAccessInput = {
    url: string;
    observedAt: string;
    httpStatus?: number | null;
    contentType?: string;
    bodyText?: string;
    extractedText?: string;
    failure?: 'TIMEOUT' | 'NETWORK_ERROR' | 'NOT_ATTEMPTED';
};
export type SourceAccessRecord = {
    schemaVersion: 'agentel.source-access/v1';
    url: string;
    observedAt: string;
    httpStatus: number | null;
    contentType: string | null;
    state: 'READABLE' | 'NOT_COVERED';
    reason: 'TEXT_AVAILABLE' | 'ACCESS_DENIED' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'REDIRECT_NOT_FOLLOWED' | 'EMPTY_OR_SCRIPT_SHELL' | 'EXTRACTION_REQUIRED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'NOT_ATTEMPTED';
    verification: 'UNVERIFIED';
    claimsSupported: false;
};
/** Does not fetch, follow redirects, authenticate, retry, retain bodies, or mark evidence verified. */
export declare function assessSourceAccess(input: SourceAccessInput): SourceAccessRecord;
export declare function sourceCoverage(records: readonly SourceAccessRecord[]): {
    state: "NOT_COVERED" | "READABLE_SOURCE_AVAILABLE";
    readableSources: string[];
    failedSources: SourceAccessRecord[];
    findings: "UNKNOWN";
    completeProviderCoverage: false;
};
