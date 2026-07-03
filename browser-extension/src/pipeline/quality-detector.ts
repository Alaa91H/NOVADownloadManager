export function qualityLabel(width?:number,height?:number){ if(height) return `${height}p`; if(width && width>=3840) return '4k'; return undefined; }
