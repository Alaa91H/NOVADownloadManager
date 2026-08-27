export interface DownloadUrlCandidate {
  url?: unknown;
}

/**
 * Returns whether a submitted URL exactly matches a URL already represented by
 * a task. This deliberately avoids URL canonicalization: paths, query strings,
 * fragments, credentials, and case can all be meaningful for an authenticated
 * or signed download request. The caller owns trimming user-input whitespace
 * before invoking this predicate.
 */
export function hasExactDownloadUrlDuplicate(submittedUrl: string, tasks: readonly DownloadUrlCandidate[]): boolean {
  if (!submittedUrl) return false;

  return tasks.some((task) => typeof task.url === 'string' && task.url === submittedUrl);
}
