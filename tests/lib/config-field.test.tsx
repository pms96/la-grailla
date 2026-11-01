import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfigField } from '@/app/admin/_components/config-field';

const render = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const noop = () => {};

/* H-095: los campos `type="password"` de Configuración (claves de Stripe y SumUp, contraseña SMTP, clave de Turnstile…) no decían `autoComplete="new-password"`: Chrome podía
 * rellenarlos con la contraseña guardada del administrador y «Guardar» la persistía como clave secreta de la pasarela. */

describe('ConfigField: el navegador no rellena credenciales ajenas (H-095)', () => {
  it('un campo de contraseña pide new-password y no se ofrece a gestores de contraseñas', () => {
    const html = render(<ConfigField label="Secret Key" type="password" value="" onChange={noop} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('data-1p-ignore');
    expect(html).toContain('data-lpignore="true"');
  });

  it('un campo de texto de configuración tampoco se autorrellena (p. ej. el usuario SMTP con el correo del administrador)', () => {
    const html = render(<ConfigField label="Usuario" value="" onChange={noop} />);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-1p-ignore');
  });

  it('el área de texto y el campo numérico siguen igual (sin autocompletado raro)', () => {
    expect(render(<ConfigField label="Texto" type="textarea" value="" onChange={noop} />)).toContain('<textarea');
    expect(render(<ConfigField label="N" type="number" value="3" onChange={noop} />)).toContain('type="number"');
  });

  it('la etiqueta sigue asociada al campo', () => {
    const html = render(<ConfigField label="Clave" type="password" value="" onChange={noop} />);
    const id = /id="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`for="${id}"`);
  });
});
