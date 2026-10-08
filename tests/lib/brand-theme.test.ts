import { describe, expect, it } from 'vitest';
import {
  BRAND_FONTS_ATTR,
  FONT_CATALOG,
  FONT_KEYS,
  TOKEN_KEYS,
  buildThemeCss,
  contrastRatio,
  deriveTokens,
  hexToHsl,
  hslToHex,
  isBrandAssetUrl,
  themeContrastWarnings,
  parseTheme,
  themeContrastIssues,
  type SiteTheme,
} from '@/lib/brand/theme';
import { neutralTheme, resolveBrand } from '@/lib/brand/brand';

const base = (over: Partial<SiteTheme> = {}): SiteTheme => ({ ...neutralTheme('Demo'), ...over });
const parseTriplet = (v: string) => {
  const [h, s, l] = v.split(' ');
  return { h: parseFloat(h), s: parseFloat(s), l: parseFloat(l) };
};

describe('parseTheme: solo entra un tema válido', () => {
  const valid = {
    v: 1,
    template: 'editorial',
    colors: { primary: '#1D4ED8', accent: '#F59E0B' },
    brand: { name: 'Demo' },
  };

  it('acepta un tema mínimo y rellena los valores por defecto', () => {
    const t = parseTheme(valid);
    expect(t).not.toBeNull();
    expect(t?.radius).toBe('suave');
    expect(t?.mode).toBe('dark');
    expect(t?.fonts).toEqual({ display: 'fredoka', body: 'space-grotesk' });
    expect(t?.brand.legalName).toBe('');
  });

  it('acepta el JSON como cadena (así se guarda en AppConfig) y rechaza basura', () => {
    expect(parseTheme(JSON.stringify(valid))).not.toBeNull();
    expect(parseTheme('{no es json')).toBeNull();
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme('')).toBeNull();
  });

  it.each([
    ['color que no es #RRGGBB', { ...valid, colors: { primary: 'red', accent: '#F59E0B' } }],
    ['color con inyección', { ...valid, colors: { primary: '#fff;}body{display:none', accent: '#F59E0B' } }],
    ['versión desconocida', { ...valid, v: 2 }],
    ['plantilla desconocida', { ...valid, template: 'neon' }],
    ['tipografía fuera del catálogo', { ...valid, fonts: { display: 'comic-sans', body: 'inter' } }],
    ['tipografía solo de titulares usada como texto', { ...valid, fonts: { display: 'inter', body: 'bebas-neue' } }],
    ['nombre vacío', { ...valid, brand: { name: '   ' } }],
    ['nombre larguísimo', { ...valid, brand: { name: 'x'.repeat(61) } }],
    ['radio desconocido', { ...valid, radius: 'circular' }],
  ])('rechaza %s', (_n, value) => {
    expect(parseTheme(value)).toBeNull();
  });

  it('un titular con la tipografía de cartel sí es válido', () => {
    expect(parseTheme({ ...valid, fonts: { display: 'bebas-neue', body: 'inter' } })).not.toBeNull();
  });
});

describe('URLs de recursos de marca', () => {
  it.each([
    ['/brand/logo-white.png', true],
    ['https://abc123.public.blob.vercel-storage.com/01HF/brand/logo.png', true],
    ['http://abc123.public.blob.vercel-storage.com/x.png', false],
    ['https://evil.com/logo.png', false],
    ['https://evil.com/?x=.public.blob.vercel-storage.com', false],
    ['https://public.blob.vercel-storage.com/x.png', false],
    ['https://abc.public.blob.vercel-storage.com/x.png?token=1', false],
    ['https://user:pw@abc.public.blob.vercel-storage.com/x.png', false],
    ['javascript:alert(1)', false],
    ['data:image/png;base64,AAAA', false],
    ['/brand/../../etc/passwd', false],
    ['//evil.com/x.png', false],
    ['/brand/..', false],
    ['/brand/.', false],
    ['/og-image.png', true],
    ['/icon-32.png', true],
    ['/admin.png', false],
  ])('%s → %s', (url, ok) => {
    expect(isBrandAssetUrl(url)).toBe(ok);
  });

  it('un tema con un logo de otro host no se guarda', () => {
    const t = { v: 1, colors: { primary: '#1D4ED8', accent: '#F59E0B' }, brand: { name: 'Demo' }, assets: { logoOnDark: 'https://evil.com/x.png' } };
    expect(parseTheme(t)).toBeNull();
  });
});

describe('derivación de colores', () => {
  it('ida y vuelta hex ↔ HSL', () => {
    for (const hex of ['#3d2fd5', '#c5e63a', '#ff0000', '#00ff00', '#0000ff', '#808080', '#ffffff', '#000000']) {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    }
  });

  it('el HSL del morado de La Grailla coincide con el de globals.css', () => {
    const { h, s, l } = hexToHsl('#3d2fd5');
    expect(Math.round(h)).toBe(245);
    // globals.css lo redondea a mano a «245 65% 51%»; el cálculo exacto de #3d2fd5 da 66.4 % de saturación.
    expect(Math.abs(s - 65)).toBeLessThan(2);
    expect(Math.round(l)).toBe(51);
  });

  it('define todos los tokens de la lista cerrada, en ambos modos y con formato seguro', () => {
    const { light, dark } = deriveTokens(base());
    for (const set of [light, dark]) {
      expect(Object.keys(set).sort()).toEqual([...TOKEN_KEYS].sort());
      for (const v of Object.values(set)) expect(v).toMatch(/^\d{1,3}(\.\d)? \d{1,3}(\.\d)?% \d{1,3}(\.\d)?%$/);
    }
  });

  it('el texto sobre el color principal y de acento es legible para cualquier color de marca', () => {
    // Barrido de tonos y luminosidades: el primer plano elegido siempre cumple AA (4.5) sobre el color.
    for (let h = 0; h < 360; h += 20) {
      for (const l of [8, 20, 35, 50, 65, 80, 92]) {
        const hex = hslToHex({ h, s: 70, l });
        const { light, dark } = deriveTokens({ colors: { primary: hex, accent: hex } });
        for (const set of [light, dark]) {
          expect(contrastRatio(parseTriplet(set.primary), parseTriplet(set['primary-foreground']))).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(parseTriplet(set.accent), parseTriplet(set['accent-foreground']))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('el texto sobre el fondo es legible con las superficies por defecto y con las elegidas', () => {
    for (const colors of [
      { primary: '#1d4ed8', accent: '#f59e0b' },
      { primary: '#3d2fd5', accent: '#c5e63a', surfaceDark: '#0b0b14', surfaceLight: '#faf7f2' },
      { primary: '#be123c', accent: '#0f766e', surfaceDark: '#1a0a10' },
    ]) {
      expect(themeContrastIssues({ colors })).toEqual([]);
    }
  });

  it('un tema ilegible se detecta (fondo oscuro casi blanco)', () => {
    const issues = themeContrastIssues({ colors: { primary: '#1d4ed8', accent: '#f59e0b', surfaceDark: '#f5f5f5' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/modo oscuro/);
  });

  it('las superficies de las tarjetas y bordes se derivan de la superficie elegida (no de la de La Grailla)', () => {
    const { dark } = deriveTokens({ colors: { primary: '#1d4ed8', accent: '#f59e0b', surfaceDark: '#10201a' } });
    const bg = parseTriplet(dark.background);
    expect(Math.round(bg.h)).toBe(Math.round(hexToHsl('#10201a').h));
    expect(parseTriplet(dark.card).l).toBeGreaterThan(bg.l);
    expect(parseTriplet(dark.border).l).toBeGreaterThan(parseTriplet(dark.card).l);
  });
});

describe('CSS del tema', () => {
  it('emite los dos modos, el radio y las tipografías elegidas', () => {
    const css = buildThemeCss(base({ radius: 'redondo', fonts: { display: 'playfair-display', body: 'dm-sans' } }));
    expect(css).toContain(':root{');
    expect(css).toContain('.dark{');
    expect(css).toContain('--radius:1rem;');
    expect(css).toContain(`body[${BRAND_FONTS_ATTR}]{--font-display:var(--f-playfair-display);--font-sans:var(--f-dm-sans);}`);
    // .dark va DESPUÉS de :root: a igualdad de especificidad gana la última.
    expect(css.indexOf('.dark{')).toBeGreaterThan(css.indexOf(':root{'));
  });

  it('solo contiene caracteres de una hoja de estilo normal y nunca el texto del cliente', () => {
    const t = base({ brand: { name: '</style><script>alert(1)</script>', tagline: '', description: '', legalName: '', sticker: '' } });
    const css = buildThemeCss(t);
    expect(css).not.toContain('script');
    expect(css).not.toContain('<');
    expect(css).not.toContain('alert');
  });

  it('cada tipografía del catálogo tiene su propia variable (ninguna apunta a la de otra)', () => {
    const vars = FONT_KEYS.map((k) => FONT_CATALOG[k].cssVar);
    expect(new Set(vars).size).toBe(vars.length);
    // Permutar las dos de La Grailla no genera una referencia circular: ninguna usa --font-display ni --font-sans.
    expect(vars).not.toContain('--font-display');
    expect(vars).not.toContain('--font-sans');
  });
});

describe('resolveBrand: de dónde sale la marca', () => {
  it('La Grailla sin tema: su marca y sin CSS añadido', () => {
    const b = resolveBrand(null, true, 'grupolagrailla@gmail.com', 'x.es');
    expect(b.name).toBe('La Grailla');
    expect(b.legalName).toBe('Grupo La Grailla');
    expect(b.theme).toBeNull();
    expect(b.template).toBe('feria');
    expect(b.mode).toBe('dark');
    expect(b.logoOnDark).toBe('/brand/logo-white.png');
    expect(b.logoOnLight).toBe('/brand/logo-black.png');
    expect(b.colors.primary).toBe('#3d2fd5');
    expect(b.contactEmail).toBe('grupolagrailla@gmail.com');
  });

  it('un cliente nuevo sin tema NO hereda nada de La Grailla', () => {
    const b = resolveBrand(null, false, '', 'cliente-a.es');
    expect(JSON.stringify(b)).not.toMatch(/grailla/i);
    expect(b.name).toBe('cliente-a.es');
    expect(b.logoOnDark).toBeNull();
    expect(b.logoOnLight).toBeNull();
    expect(b.favicon).toBeNull();
    expect(b.ogImage).toBeNull();
    expect(b.contactEmail).toBe('');
    expect(b.theme).not.toBeNull();
  });

  it('La Grailla con un tema guardado sin logos conserva sus logos; otro cliente no', () => {
    const t = base({ brand: { name: 'La Grailla', tagline: '', description: '', legalName: '', sticker: '' } });
    expect(resolveBrand(t, true, '', 'x').logoOnDark).toBe('/brand/logo-white.png');
    expect(resolveBrand(t, false, '', 'x').logoOnDark).toBeNull();
  });

  it('con tema: el nombre, la razón social y la descripción salen del tema', () => {
    const t = base({ brand: { name: 'Sala Norte', tagline: 'Música en directo', description: '', legalName: '', sticker: '' } });
    const b = resolveBrand(t, false, 'hola@salanorte.es', 'x');
    expect(b.name).toBe('Sala Norte');
    expect(b.legalName).toBe('Sala Norte'); // sin razón social: el nombre
    expect(b.description).toBe('Música en directo'); // sin descripción: el eslogan
    expect(b.contactEmail).toBe('hola@salanorte.es');
  });
});

describe('avisos de contraste (no bloquean)', () => {
  it('un acento claro sobre fondo claro avisa, pero el tema sigue siendo guardable', () => {
    const colors = { primary: '#1d4ed8', accent: '#b8d033' };
    expect(themeContrastIssues({ colors })).toEqual([]);
    expect(themeContrastWarnings({ colors }).join(' ')).toMatch(/acento.*modo claro|modo claro.*acento/);
  });
  it('colores con buen contraste sobre el fondo no avisan', () => {
    expect(themeContrastWarnings({ colors: { primary: '#1e3a8a', accent: '#b91c1c', surfaceDark: '#0b0b14' } }).filter((w) => w.includes('claro'))).toEqual([]);
  });
});
