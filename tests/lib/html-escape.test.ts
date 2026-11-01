import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@/lib/html-escape';
import { escapeHtml as mailerEscapeHtml } from '@/lib/mailer';
import { brandLogoHtml } from '@/lib/brand/email';
import type { Brand } from '@/lib/brand/brand';

/* H-105: había tres copias de `escapeHtml` y ninguna escapaba las comillas: un valor dentro de un atributo (`href="${website}"`) podía cerrarlo e inyectar otros. */

describe('escapeHtml', () => {
  it('escapa & < > " y \'', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('una pasada = una capa (el & va primero y no se rompen las entidades que se acaban de producir)', () => {
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml(escapeHtml('"'))).toBe('&amp;quot;');
  });

  it('null, undefined y números no rompen', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(12)).toBe('12');
  });

  it('un valor que intenta cerrar un atributo queda dentro del atributo', () => {
    const evil = 'https://x.es" style="position:fixed;inset:0" onmouseover="alert(1)';
    const html = `<a href="${escapeHtml(evil)}">enlace</a>`;
    // Una sola comilla de apertura y una de cierre: el valor no abrió atributos nuevos.
    expect(html.match(/"/g)).toHaveLength(2);
    expect(html).not.toMatch(/ style="|onmouseover="/);
  });

  it('el reexport de mailer es la misma función (una sola implementación)', () => {
    expect(mailerEscapeHtml).toBe(escapeHtml);
  });
});

describe('brandLogoHtml: atributos', () => {
  const brand = (name: string, logo: string | null) =>
    ({ name, logoOnLight: logo, logoOnDark: null, colors: { emailAccent: '#000' } }) as unknown as Brand;

  it('un nombre con comillas no sale del atributo alt', () => {
    const html = brandLogoHtml(brand('Sala "Norte" \' x', 'https://cdn.example.com/logo.png'), 'https://app.example.com', 24);
    expect(html).toContain('alt="Sala &quot;Norte&quot; &#39; x"');
  });
});
