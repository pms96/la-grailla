import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandProvider, type ClientBrand } from '@/components/brand-provider';
import { LicenseContact } from '@/components/license-contact';
import { providerContact } from '@/lib/license-support';
import { deriveTokens } from '@/lib/brand/theme';
import { contrastOnVeil } from '../helpers/contrast';
import { LicenseNotice, type LicenseNoticeProps } from '@/app/licencia/_components/license-notice';
import AdminShell from '@/app/admin/_components/admin-shell';

/* P1-19: avisos de licencia. El de GRACE usa los colores del tema (legible en claro y en oscuro), y los de PANEL_BLOCKED y BLOCKED dicen qué hacer y a
 * quién acudir, con una salida para cada rol (el escáner y cerrar sesión). Render puro, sin BD. */

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'Ana', email: 'ana@b.es', modules: null } } }),
  signOut: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/navigation')>()), usePathname: () => '/admin' }));

// Los tipos de JSX.Element y de renderToStaticMarkup vienen de versiones distintas de @types/react: se unifican aquí.
const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const NO_CONTACT = { email: null, url: null };
const notice = (over: Partial<LicenseNoticeProps> = {}) =>
  render(<LicenseNotice phase="PANEL_BLOCKED" legacy={false} brandName="Club Norte" role={null} scanner={true} contact={NO_CONTACT} {...over} />);

describe('providerContact (PLATFORM_SUPPORT_EMAIL / PLATFORM_SUPPORT_URL)', () => {
  it('sin configurar no hay contacto (no se inventa ninguno)', () => {
    expect(providerContact({})).toEqual({ email: null, url: null });
  });

  it('acepta un correo y un enlace https', () => {
    expect(providerContact({ PLATFORM_SUPPORT_EMAIL: ' soporte@proveedor.es ', PLATFORM_SUPPORT_URL: 'https://proveedor.es/pagos' })).toEqual({
      email: 'soporte@proveedor.es',
      url: 'https://proveedor.es/pagos',
    });
  });

  it('ignora lo que no es un correo o un https limpio (nunca llega a un enlace)', () => {
    for (const url of ['http://proveedor.es', 'javascript:alert(1)', 'https://u:p@proveedor.es', 'no es una url', 'ftp://x.es']) {
      expect(providerContact({ PLATFORM_SUPPORT_URL: url }).url, url).toBeNull();
    }
    for (const email of ['soporte', 'a b@c.es', '<x@y.es>', 'x@y']) expect(providerContact({ PLATFORM_SUPPORT_EMAIL: email }).email, email).toBeNull();
  });
});

describe('LicenseContact', () => {
  it('sin datos remite al proveedor de la plataforma', () => {
    expect(text(render(<LicenseContact contact={NO_CONTACT} />))).toBe('Ponte en contacto con tu proveedor de la plataforma para regularizar la licencia.');
    expect(text(render(<LicenseContact />))).toContain('tu proveedor de la plataforma');
  });

  it('con correo y/o enlace los muestra', () => {
    const both = render(<LicenseContact contact={{ email: 'soporte@proveedor.es', url: 'https://proveedor.es/pagos' }} />);
    expect(both).toContain('href="mailto:soporte@proveedor.es"');
    expect(both).toContain('href="https://proveedor.es/pagos"');
    expect(text(both)).toBe('Escribe a soporte@proveedor.es o visita proveedor.es para regularizar la licencia.');
    expect(text(render(<LicenseContact contact={{ email: 'soporte@proveedor.es', url: null }} />))).toBe('Escribe a soporte@proveedor.es para regularizar la licencia.');
    expect(text(render(<LicenseContact contact={{ email: null, url: 'https://proveedor.es' }} />))).toBe('Visita proveedor.es para regularizar la licencia.');
  });
});

describe('/licencia por fase y rol', () => {
  it('PANEL_BLOCKED, sin sesión: dice qué pasa, a quién acudir y deja volver a la web', () => {
    const html = notice();
    const t = text(html);
    expect(t).toContain('El panel está bloqueado');
    expect(t).toContain('Club Norte');
    expect(t).toContain('La web y las ventas siguen funcionando con normalidad, y el personal de puerta puede seguir validando entradas con el escáner.');
    expect(t).toContain('Ponte en contacto con tu proveedor de la plataforma para regularizar la licencia.');
    expect(html).toContain('href="/"');
    expect(t).toContain('Ir a la web');
    expect(t).not.toContain('Cerrar sesión');
    expect(html).not.toContain('href="/acceso"'); // sin sesión no hay escáner que ofrecer
  });

  it('PANEL_BLOCKED, administrador con sesión: web, escáner y cerrar sesión', () => {
    const html = notice({ role: 'ADMIN' });
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/acceso"');
    expect(text(html)).toContain('Escáner de entradas');
    expect(text(html)).toContain('Cerrar sesión');
  });

  it('PANEL_BLOCKED sin el módulo Entradas no habla del escáner', () => {
    const html = notice({ role: 'ADMIN', scanner: false });
    expect(html).not.toContain('/acceso');
    expect(text(html)).not.toContain('escáner');
    expect(text(html)).toContain('Cerrar sesión');
  });

  it('BLOCKED, visitante: sin web a la que volver, con el acceso del personal y el contacto', () => {
    const html = notice({ phase: 'BLOCKED' });
    const t = text(html);
    expect(t).toContain('Este sitio no está disponible');
    expect(t).toContain('Si administras este sitio, la licencia está pendiente de pago.');
    expect(t).toContain('Ponte en contacto con tu proveedor de la plataforma');
    expect(t).not.toContain('Ir a la web');
    expect(html).toContain('href="/auth/login"');
    expect(t).toContain('Acceso del personal');
    expect(html).not.toContain('href="/acceso"');
  });

  it('BLOCKED, TAQUILLA con sesión: ya no es un callejón, tiene el escáner y cerrar sesión', () => {
    const html = notice({ phase: 'BLOCKED', role: 'TAQUILLA' });
    expect(html).toContain('href="/acceso"');
    expect(text(html)).toContain('Escáner de entradas');
    expect(text(html)).toContain('El personal de puerta puede seguir validando entradas con el escáner.');
    expect(text(html)).toContain('Cerrar sesión');
    expect(html).not.toContain('href="/"');
  });

  it('BLOCKED, TAQUILLA en un cliente sin Entradas: al menos puede cerrar sesión', () => {
    const t = text(notice({ phase: 'BLOCKED', role: 'TAQUILLA', scanner: false }));
    expect(t).toContain('Cerrar sesión');
    expect(t).not.toContain('Escáner');
  });

  it('con contacto del proveedor configurado lo muestra en ambas fases', () => {
    const contact = { email: 'soporte@proveedor.es', url: null };
    for (const phase of ['PANEL_BLOCKED', 'BLOCKED'] as const) {
      const html = notice({ phase, contact });
      expect(html).toContain('href="mailto:soporte@proveedor.es"');
      expect(text(html)).not.toContain('proveedor de la plataforma');
    }
  });

  it('La Grailla conserva la cabecera de Feria; el resto, una sobria y sin «caseta» ni «feria»', () => {
    const legacy = notice({ legacy: true, brandName: 'La Grailla' });
    expect(legacy).toContain('hero-gradient');
    expect(legacy).toContain('brand-sticker');
    const other = notice();
    expect(other).not.toContain('hero-gradient');
    expect(other).not.toContain('brand-sticker');
    for (const phase of ['PANEL_BLOCKED', 'BLOCKED'] as const) {
      for (const role of [null, 'ADMIN', 'TAQUILLA'] as const) expect(notice({ phase, role }), `${phase}/${role}`).not.toMatch(/caseta|feria/i);
    }
  });
});

const brand: ClientBrand = { name: 'Club Norte', contactEmail: '', organizer: '', logoOnDark: null, logoOnLight: null, mode: 'light', contactFormEnabled: true, modules: ['nucleo'], legacy: false, blobPrefix: '' };
const shell = (grace: { panelBlockedAt: number | null; contact?: { email: string | null; url: string | null } }) =>
  render(
    <BrandProvider value={brand}>
      <AdminShell modules={['nucleo']} licenseGrace={grace}>
        contenido
      </AdminShell>
    </BrandProvider>,
  );

describe('aviso GRACE del panel', () => {
  const banner = (html: string) => html.match(/<div role="status"[^>]*>[\s\S]*?<\/div>/)![0];

  it('usa los colores del tema, no un ámbar fijo', () => {
    const b = banner(shell({ panelBlockedAt: 1893456000000 }));
    expect(b).not.toMatch(/amber/);
    expect(b).toContain('text-foreground');
    expect(b).toContain('bg-warm-yellow/15');
    expect(text(b)).toContain('Regulariza el pago antes del 1 de enero de 2030');
  });

  it('dice a quién acudir (sin datos del proveedor, al proveedor de la plataforma) y los muestra si existen', () => {
    expect(text(banner(shell({ panelBlockedAt: null })))).toContain('Ponte en contacto con tu proveedor de la plataforma para regularizar la licencia.');
    const con = banner(shell({ panelBlockedAt: null, contact: { email: 'soporte@proveedor.es', url: null } }));
    expect(con).toContain('href="mailto:soporte@proveedor.es"');
  });

  // Contraste WCAG del texto (`foreground`) sobre el velo del aviso (15 % del amarillo `warm-yellow` sobre el fondo de la página), en claro y en oscuro.
  const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');
  const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
  const token = (b: string, name: string) => {
    const m = b.match(new RegExp(`--${name}:\\s*([\\d.]+) ([\\d.]+)% ([\\d.]+)%`))!;
    return `${m[1]} ${m[2]}% ${m[3]}%`;
  };

  const tokenSets = {
    'globals.css claro': { background: token(block(':root {'), 'background'), foreground: token(block(':root {'), 'foreground'), warm: token(block(':root {'), 'warm-yellow') },
    // El modo oscuro no redefine `warm-yellow` (hereda el de :root).
    'globals.css oscuro': { background: token(block('.dark {'), 'background'), foreground: token(block('.dark {'), 'foreground'), warm: token(block(':root {'), 'warm-yellow') },
  } as Record<string, { background: string; foreground: string; warm: string }>;
  // Los colores de partida de un cliente nuevo (lib/brand/brand.ts, NEUTRAL).
  const derived = deriveTokens({ colors: { primary: '#1d4ed8', accent: '#f59e0b' } });
  tokenSets['tema neutro claro'] = { background: derived.light.background, foreground: derived.light.foreground, warm: derived.light['warm-yellow'] };
  tokenSets['tema neutro oscuro'] = { background: derived.dark.background, foreground: derived.dark.foreground, warm: derived.dark['warm-yellow'] };

  for (const [name, t] of Object.entries(tokenSets)) {
    it(`contraste legible (≥ 4,5:1) con ${name}`, () => {
      expect(contrastOnVeil(t.foreground, t.background, t.warm, 0.15)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('el color anterior (amber-200 sobre un velo de amber-500) NO pasaba en tema claro: el test detecta el problema que se corrige', () => {
    // amber-200 ≈ hsl(48 97% 77%), amber-500 ≈ hsl(38 92% 50%) sobre el blanco del tema claro.
    expect(contrastOnVeil('48 97% 77%', '0 0% 100%', '38 92% 50%', 0.1)).toBeLessThan(2);
  });
});
