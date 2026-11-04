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
function publicUrl(value:string) {
  let url:URL;try{url=new URL(value);}catch{throw new Error('Use a public HTTPS source URL.');}
  if(value.length>2000||url.protocol!=='https:'||url.username||url.password)throw new Error('Use a public HTTPS source URL without credentials.');
  if(/^(localhost|127\.|10\.|192\.168\.|\[)/i.test(url.hostname)||/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname))throw new Error('Local/private source URLs are not public evidence.');
  for(const key of [...url.searchParams.keys(),...new URLSearchParams(url.hash.slice(1)).keys()])if(/^(token|access_token|api_key|key|signature|authorization|password|secret|code)$/i.test(key))throw new Error('Remove credentials from source URLs before recording public evidence.');
  return url.toString();
}
/** Does not fetch, follow redirects, authenticate, retry, retain bodies, or mark evidence verified. */
export function assessSourceAccess(input:SourceAccessInput):SourceAccessRecord {
  const url=publicUrl(input.url);
  if(!/^\d{4}-\d\d-\d\dT/.test(input.observedAt)||!Number.isFinite(Date.parse(input.observedAt)))throw new Error('observedAt must be an explicit ISO observation timestamp.');
  const httpStatus=input.httpStatus??null;
  if(httpStatus!==null&&(!Number.isSafeInteger(httpStatus)||httpStatus<100||httpStatus>599))throw new Error('Invalid observed HTTP status.');
  if(input.failure&&!['TIMEOUT','NETWORK_ERROR','NOT_ATTEMPTED'].includes(input.failure))throw new Error('Invalid source failure.');
  const contentType=input.contentType?.split(';')[0].trim().toLowerCase()??null;
  let reason:SourceAccessRecord['reason'];
  if(input.failure)reason=input.failure;
  else if(httpStatus===401)reason='AUTH_REQUIRED';
  else if(httpStatus===403)reason='ACCESS_DENIED';
  else if(httpStatus===429)reason='RATE_LIMITED';
  else if(httpStatus!==null&&httpStatus>=300&&httpStatus<400)reason='REDIRECT_NOT_FOLLOWED';
  else if(httpStatus===null)reason='NOT_ATTEMPTED';
  else if(httpStatus<200||httpStatus>=300)reason='HTTP_ERROR';
  else if(input.extractedText?.trim())reason='TEXT_AVAILABLE';
  else if(contentType&&!/^(text\/|application\/(?:json|rss\+xml|atom\+xml|xml)$)/.test(contentType))reason='EXTRACTION_REQUIRED';
  else {
    const raw=input.bodyText??'';
    const visible=raw.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(?:head|script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:head|script|style|noscript)>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/\s+/g,' ').trim();
    if(/^(?:verify (?:that )?you are human|just a moment|checking your browser|access denied|captcha required)/i.test(visible))reason='ACCESS_DENIED';
    else reason=!visible||/^(?:loading[.!…\s]*|please enable javascript[.!…\s]*|javascript (?:is )?required[.!…\s]*)$/i.test(visible)?'EMPTY_OR_SCRIPT_SHELL':'TEXT_AVAILABLE';
  }
  return {schemaVersion:'agentel.source-access/v1',url,observedAt:new Date(input.observedAt).toISOString(),httpStatus,contentType,state:reason==='TEXT_AVAILABLE'?'READABLE':'NOT_COVERED',reason,verification:'UNVERIFIED',claimsSupported:false};
}
export function sourceCoverage(records:readonly SourceAccessRecord[]) {
  const readable=records.filter(record=>record.state==='READABLE');
  return {state:readable.length?'READABLE_SOURCE_AVAILABLE' as const:'NOT_COVERED' as const,readableSources:readable.map(record=>record.url),failedSources:records.filter(record=>record.state==='NOT_COVERED'),findings:'UNKNOWN' as const,completeProviderCoverage:false as const};
}
