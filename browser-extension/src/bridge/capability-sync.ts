import { CapabilityRegistry, CapabilitiesSchema } from '../contracts/capabilities.schema';
import { ExtensionSettingsResponseSchema } from '../contracts/nova.protocol.v4';
import { TransportManager } from '../transport/transport-manager';
export class CapabilitySync { readonly registry=new CapabilityRegistry(); constructor(private tm:TransportManager){} async refresh(token:string){ const s=await this.tm.requestHttp('/v1/extension-settings',undefined,ExtensionSettingsResponseSchema,token,'GET'); const caps=CapabilitiesSchema.parse(s.capabilities ?? {items:[]}); this.registry.update(caps); return caps; } }
