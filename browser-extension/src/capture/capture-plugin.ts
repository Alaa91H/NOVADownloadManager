import { Candidate } from '../contracts/candidate.schema';
import { CaptureContext } from './capture-context';
export type BrowserName='chrome'|'edge'|'firefox';
export type CapturePlugin = { id:string; name:string; requiredPermissions:string[]; supportedBrowsers:ReadonlyArray<BrowserName>; isEnabled(context:CaptureContext):Promise<boolean>; capture(context:CaptureContext):Promise<Candidate[]>; };
