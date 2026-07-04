export class ReconnectPolicy { private i=0; private delays=[2000,5000,15000,30000,60000]; next(){ return this.delays[Math.min(this.i++, this.delays.length-1)] ?? 60000; } reset(){ this.i=0; } }
