import { redact } from '../security/redaction';
export type LogLevel='debug'|'info'|'warn'|'error';
export class Logger { constructor(private scope:string){} private write(level:LogLevel,msg:string,meta?:unknown){ const safe=meta===undefined?undefined:redact(meta); console[level === 'debug' ? 'debug' : level](`[NOVA:${this.scope}] ${msg}`, safe ?? ''); } debug(m:string,x?:unknown){this.write('debug',m,x)} info(m:string,x?:unknown){this.write('info',m,x)} warn(m:string,x?:unknown){this.write('warn',m,x)} error(m:string,x?:unknown){this.write('error',m,x)} }
