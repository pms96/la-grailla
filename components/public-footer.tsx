import Link from 'next/link';
import { Logo } from '@/components/logo';
import { getConfigs } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';
import { isLinkVisible } from '@/lib/modules/registry';
import { getActiveModules } from '@/lib/modules/runtime';
import { SOCIAL_KEYS, socialLinks } from '@/lib/social-links';

/* Las clases `site-footer*` no llevan estilo por sí solas: son el enganche de `components/templates/shell.css`, donde cada plantilla le da al pie su
 * forma (Feria y Editorial se quedan con las clases de Tailwind de abajo, que son las de siempre). */
export default async function PublicFooter({ contact = false }: { contact?: boolean } = {}) {
  const [copy, brand] = await Promise.all([getConfigs(['footer_tagline', 'footer_copyright', ...SOCIAL_KEYS]), getBrand()]);
  const socials = socialLinks(copy);
  // Los textos del pie son editables en Configuración → Contenido; sin ellos, el eslogan de la marca y un © con la razón social.
  const tagline = copy.footer_tagline || brand.tagline;
  const copyright = copy.footer_copyright || `© ${new Date().getFullYear()} ${brand.legalName}`;
  const modules = getActiveModules();
  const show = (href: string) => isLinkVisible(href, modules);

  return (
    <footer className="site-footer relative border-t border-border/30 bg-card/80">
      <div className="site-footer__inner max-w-[1200px] mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Brand */}
          <div className="flex flex-col items-center md:items-start gap-2">
            <Logo className="h-6" />
            <p className="site-footer__tagline text-sm text-muted-foreground text-center md:text-left">
              {tagline}
            </p>
          </div>

          {/* Links */}
          <div className="flex flex-col items-center md:items-end gap-3">
            <div className="site-footer__links flex gap-6 text-sm font-medium">
              {show('/eventos') && <Link href="/eventos" className="text-muted-foreground hover:text-primary transition-colors">Eventos</Link>}
              {show('/tienda') && <Link href="/tienda" className="text-muted-foreground hover:text-primary transition-colors">Tienda</Link>}
              {show('/sponsors') && <Link href="/sponsors" className="text-muted-foreground hover:text-primary transition-colors">Patrocinio</Link>}
              {contact && <Link href="/#contacto" className="text-muted-foreground hover:text-primary transition-colors">Contacto</Link>}
            </div>
            {socials.length > 0 && (
              <div className="site-footer__social flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
                {socials.map((s) => (
                  <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer me" className="text-muted-foreground hover:text-primary transition-colors">
                    {s.label}
                  </a>
                ))}
              </div>
            )}
            <div className="site-footer__legal flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <Link href="/legal/aviso-legal" className="hover:text-primary transition-colors">Aviso legal</Link>
              {show('/eventos') && <Link href="/legal/condiciones-entradas" className="hover:text-primary transition-colors">Condiciones de entradas</Link>}
              {show('/tienda') && <Link href="/legal/condiciones-tienda" className="hover:text-primary transition-colors">Condiciones de tienda</Link>}
              <Link href="/legal/privacidad" className="hover:text-primary transition-colors">Privacidad</Link>
              <Link href="/legal/cookies" className="hover:text-primary transition-colors">Cookies</Link>
            </div>
          </div>

          {/* Copy */}
          <p className="site-footer__copy text-xs text-muted-foreground">
            <span suppressHydrationWarning>{copyright}</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
