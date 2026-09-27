import { describe,it,expect } from 'vitest';
import { normalizeUrl } from '../../utils/url';
describe('normalizeUrl',()=>{ it('removes tracking but preserves signed query',()=>{ expect(normalizeUrl('HTTPS://Example.COM/a.bin?utm_source=x&sig=abc')).toBe('https://example.com/a.bin?sig=abc'); }); });
