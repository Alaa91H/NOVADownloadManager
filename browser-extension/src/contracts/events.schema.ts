import { z } from 'zod';

export const NovaEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), at: z.string().optional() }),
  z.object({ type: z.literal('heartbeat'), at: z.string().optional() }),
  z.object({ type: z.literal('task.updated'), taskId: z.string(), status: z.string().optional(), progress: z.number().min(0).max(100).optional() }),
  z.object({ type: z.literal('task.completed'), taskId: z.string(), filename: z.string().optional() }),
  z.object({ type: z.literal('task.failed'), taskId: z.string(), message: z.string().optional(), retryable: z.boolean().optional() }),
  z.object({ type: z.literal('settings.updated'), settings: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('capabilities.updated'), capabilities: z.record(z.string(), z.unknown()).optional() }),
]);
export type NovaEvent = z.infer<typeof NovaEventSchema>;
