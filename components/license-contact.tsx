import type { ProviderContact } from '@/lib/license-support';

/* Frase que dice a quién acudir para regularizar la licencia. Sin datos del proveedor remite al «proveedor de la plataforma» (no inventa un
 * contacto). Sin hooks ni estado: la usan el aviso del panel (cliente) y la pantalla /licencia (servidor). */

export function LicenseContact({ contact }: { contact?: ProviderContact | null }) {
  const email = contact?.email ?? null;
  const url = contact?.url ?? null;
  if (!email && !url) return <>Ponte en contacto con tu proveedor de la plataforma para regularizar la licencia.</>;
  const link = 'font-medium underline underline-offset-2';
  return (
    <>
      {email ? 'Escribe a ' : 'Visita '}
      {email && (
        <a href={`mailto:${email}`} className={link}>
          {email}
        </a>
      )}
      {email && url && ' o visita '}
      {url && (
        <a href={url} className={link} rel="noopener noreferrer">
          {new URL(url).host}
        </a>
      )}{' '}
      para regularizar la licencia.
    </>
  );
}
