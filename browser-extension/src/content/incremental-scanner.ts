const seenUrls = new Set<string>();
const MAX_SEEN_URLS = 10000;

export function getSeenUrls(): Set<string> {
  return seenUrls;
}

export function resetSeenUrls(): void {
  seenUrls.clear();
}

export function markUrlSeen(url: string): void {
  if (seenUrls.size >= MAX_SEEN_URLS) seenUrls.clear();
  seenUrls.add(url);
}

export function isUrlNew(url: string): boolean {
  return !seenUrls.has(url);
}

export function filterNewUrls(urls: string[]): string[] {
  const fresh: string[] = [];
  for (const url of urls) {
    if (seenUrls.size >= MAX_SEEN_URLS) seenUrls.clear();
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      fresh.push(url);
    }
  }
  return fresh;
}

export function filterNew<T extends { url?: string; finalUrl?: string }>(candidates: T[]): T[] {
  const fresh: T[] = [];
  for (const candidate of candidates) {
    const url = candidate.finalUrl ?? candidate.url;
    if (!url) continue;
    if (seenUrls.size >= MAX_SEEN_URLS) seenUrls.clear();
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      fresh.push(candidate);
    }
  }
  return fresh;
}
