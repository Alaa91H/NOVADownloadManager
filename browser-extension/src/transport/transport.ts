import { z } from 'zod';
export interface Transport { readonly id: 'native'|'http'|'sse'|'websocket'; isAvailable(): Promise<boolean>; request<T>(route: string, payload: unknown, schema: z.ZodType<T>, options?: { token?: string; method?: 'GET'|'POST' }): Promise<T>; close(): Promise<void>; }
