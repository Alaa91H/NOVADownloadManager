import { expect,it } from 'vitest';
import { CandidateScorer } from '../../pipeline/scorer';
it('scores rich candidates high',()=>{ const s=new CandidateScorer().score({id:'1',url:'https://x/a.mp4',source:'dom',mediaType:'video',mimeType:'video/mp4',headers:{contentDisposition:'attachment; filename=a.mp4'},sizeBytes:10000000,filename:'a.mp4',extension:'mp4',confidence:0,createdAt:new Date().toISOString()}); expect(s).toBeGreaterThan(80); });
