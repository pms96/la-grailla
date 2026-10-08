import { describe, it, expect } from 'vitest';
import { isCrossOriginMutation } from '@/lib/origin';

describe('isCrossOriginMutation', () => {
  it('deja pasar las lecturas y los POST del mismo origen', () => {
    expect(isCrossOriginMutation('GET', 'https://evil.example', 'panel.example')).toBe(false);
    expect(isCrossOriginMutation('POST', 'https://panel.example', 'panel.example')).toBe(false);
    expect(isCrossOriginMutation('POST', 'http://localhost:3200', 'localhost:3200')).toBe(false);
  });

  it('rechaza un POST de otro origen, de otro puerto o con Origin "null"', () => {
    expect(isCrossOriginMutation('POST', 'https://evil.example', 'panel.example')).toBe(true);
    expect(isCrossOriginMutation('POST', 'http://localhost:3201', 'localhost:3200')).toBe(true);
    expect(isCrossOriginMutation('POST', 'null', 'panel.example')).toBe(true);
    expect(isCrossOriginMutation('PUT', 'no-es-una-url', 'panel.example')).toBe(true);
  });

  it('sin cabecera Origin no bloquea (lo cubren SameSite=Strict y las acciones de Next)', () => {
    expect(isCrossOriginMutation('POST', null, 'panel.example')).toBe(false);
  });
});
