import { z } from 'zod';
export const ErrorCodeSchema = z.enum(['NOVA_NOT_RUNNING','NATIVE_HOST_MISSING','DAEMON_UNAVAILABLE','PAIRING_FAILED','TOKEN_MISSING','TOKEN_INVALID','TOKEN_EXPIRED','PROTOCOL_MISMATCH','BROWSER_INTEGRATION_DISABLED','CAPABILITY_UNSUPPORTED','TASK_REJECTED','NETWORK_ERROR','TIMEOUT','PERMISSION_MISSING','VALIDATION_FAILED','OUTBOX_FAILED','UNKNOWN_ERROR']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const BridgeErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string(), retryable: z.boolean(), repairHint: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() });
export type BridgeError = z.infer<typeof BridgeErrorSchema>;
export function bridgeError(code: ErrorCode, message: string, retryable=false, repairHint?: string): BridgeError { return { code, message, retryable, ...(repairHint ? { repairHint } : {}) }; }
