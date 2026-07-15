import { Candidate } from '../contracts/candidate.schema';
import { ContentScanResponse } from '../contracts/messages.schema';

export type NetworkCaptureEntry = {
  url: string;
  finalUrl?: string;
  pageUrl?: string;
  referrer?: string;
  headers?: Candidate['headers'];
  tabId?: number;
};

export type DownloadCaptureEntry = {
  url: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  fileSize?: number;
  totalBytes?: number;
  referrer?: string;
  tabId?: number;
};

export type CaptureContext = {
  tabId?: number;
  pageUrl?: string;
  documentUrl?: string;
  html?: string;
  content?: ContentScanResponse;
  networkEntries?: NetworkCaptureEntry[];
  downloadEntries?: DownloadCaptureEntry[];
  now?: string;
  userActivated?: boolean;
  linkUrl?: string;
  srcUrl?: string;
  selectionText?: string;
};
