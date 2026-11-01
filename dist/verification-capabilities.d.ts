/** Capability input normalization shared with the server; no network or catalog dependency. */
export type CustomCapability = {
    raw: string;
    label: string;
};
export declare function normalizeCapabilityInput(ids?: unknown, custom?: unknown): {
    capabilityIds: string[];
    customCapabilities: CustomCapability[];
};
