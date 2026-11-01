/** Capability input normalization shared with the server; no network or catalog dependency. */
export type CustomCapability = { raw: string; label: string };
export function normalizeCapabilityInput(ids: unknown = [], custom: unknown = []) {
  if (!Array.isArray(ids) || !Array.isArray(custom) || ids.length > 2 || custom.length > 2 || ids.some(x => typeof x !== "string") || custom.some(x => typeof x !== "string")) throw new Error("capability_ids/custom_capabilities must be arrays of at most 2 strings each.");
  const capabilityIds = [...new Set((ids as string[]).map(x => x.trim()))];
  if (capabilityIds.some(x => !x)) throw new Error("capability_ids contains an empty ID.");
  const customCapabilities: CustomCapability[] = [];
  const seen = new Set<string>();
  for (const raw of custom as string[]) {
    if ([...raw].length > 320 || [...raw].some(c=>{const n=c.codePointAt(0)!;return n <= 31 || (n >= 127 && n <= 159);}) || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(raw) || /[\ud800-\udfff]/u.test(raw)) throw new Error("custom_capabilities contains unsafe characters or exceeds 320 code points.");
    const label = raw.normalize("NFC").trim().replace(/\s+/gu," ");
    if (!label || [...label].length > 80 || !label.replace(/\p{Default_Ignorable_Code_Point}|\s/gu, "")) throw new Error("custom_capabilities must normalize to 1–80 visible code points.");
    const key = label.replace(/[A-Z]/g, c => c.toLowerCase());
    if (!seen.has(key)) { seen.add(key); customCapabilities.push({raw,label}); }
  }
  if (capabilityIds.length + customCapabilities.length < 1 || capabilityIds.length + customCapabilities.length > 2) throw new Error("Provide 1 or 2 capabilities in total; catalog IDs are optional. See /api/v1/verification-capability-catalog.");
  return {capabilityIds,customCapabilities};
}
