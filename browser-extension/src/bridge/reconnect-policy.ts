export class ReconnectPolicy { private i=0; private delays=[2000,3000,5000,5000,5000]; next(){ return this.delays[Math.min(this.i++, this.delays.length-1)] ?? 5000; } reset(){ this.i=0; } }
