import { normalizeSafeHeaderValue } from './header-normalization';

// Cookie and Authorization headers are intentionally not allowlisted.
const map: Record<string,string> = {
  'content-type':'contentType',
  'content-length':'contentLength',
  'content-range':'contentRange',
  'content-disposition':'contentDisposition',
  'accept-ranges':'acceptRanges',
  'etag':'etag',
  'last-modified':'lastModified',
};

export function safeHeaders(headers:Record<string,string>):Record<string,string>{
  const out:Record<string,string>={};
  for(const [k,v] of Object.entries(headers)){
    const name=map[k.toLowerCase()];
    if(!name) continue;
    const normalized = normalizeSafeHeaderValue(v);
    if(normalized !== undefined) out[name]=normalized;
  }
  return out;
}
