import { z } from 'zod';
import { BridgeErrorSchema } from '../contracts/errors.schema';
import { CapabilitiesSchema } from '../contracts/capabilities.schema';
export const BridgeStatusSchema = z.enum(['idle','booting','discovering','nativeChecking','daemonChecking','pairing','authChecking','capabilitySyncing','connected','degraded','reconnecting','offline','protocolMismatch','integrationDisabled','tokenExpired','fatal']);
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;
export const BridgeStateSchema = z.object({ status: BridgeStatusSchema, canSend: z.boolean(), transport: z.enum(['native','http','mixed']).nullable(), protocolVersion: z.number().optional(), minimumSupportedProtocolVersion: z.number().optional(), capabilities: CapabilitiesSchema.optional(), lastError: BridgeErrorSchema.optional(), lastConnectedAt: z.string().optional(), retryAfterMs: z.number().optional() });
export type BridgeState = z.infer<typeof BridgeStateSchema>;
export const initialBridgeState: BridgeState = { status: 'idle', canSend: false, transport: null };
