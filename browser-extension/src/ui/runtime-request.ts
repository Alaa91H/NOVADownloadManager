import browser from 'webextension-polyfill';
import { isRuntimeErrorResponse, runtimeErrorMessage } from '../contracts/runtime-response.schema';

export async function runtimeRequest<T = unknown>(message: Record<string, unknown>): Promise<T> {
  const response = await browser.runtime.sendMessage(message);
  if (isRuntimeErrorResponse(response)) throw new Error(runtimeErrorMessage(response));
  return response as T;
}

export function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected extension error.';
}
