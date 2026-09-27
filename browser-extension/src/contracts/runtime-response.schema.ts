import { z } from 'zod';
import { ErrorCodeSchema } from './errors.schema';

export const RuntimeErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: ErrorCodeSchema.or(z.string().min(1)).default('UNKNOWN_ERROR'),
  message: z.string().default('Extension request failed.'),
  retryable: z.boolean().optional(),
  repairHint: z.string().optional(),
  details: z.unknown().optional(),
  issues: z.unknown().optional(),
});

export type RuntimeErrorResponse = z.infer<typeof RuntimeErrorResponseSchema>;

export function isRuntimeErrorResponse(value: unknown): value is RuntimeErrorResponse {
  return RuntimeErrorResponseSchema.safeParse(value).success;
}

export function runtimeErrorMessage(value: RuntimeErrorResponse): string {
  const prefix = value.code ? `${value.code}: ` : '';
  return `${prefix}${value.message}`;
}

// Unified success envelope for the LIST_TASKS runtime route. The popup reads
// `result.tasks`, so the router must always return an object envelope here and
// never a bare array. Tasks are opaque records validated further downstream.
export const ListTasksResponseSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
