import { expect,it } from 'vitest';
import { PingResponseSchema } from '../../contracts/adm.protocol.v4';
it('validates ADM v4 ping',()=>{ expect(PingResponseSchema.parse({ok:true,app:'APEX Download Manager',appVersion:'0.1.0',protocolVersion:4,minimumSupportedProtocolVersion:2,browserIntegrationEnabled:true}).protocolVersion).toBe(4); });
