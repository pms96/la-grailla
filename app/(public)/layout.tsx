import PublicNav from '@/components/public-nav';
import PublicFooter from '@/components/public-footer';
import CookieBanner from '@/components/cookie-banner';
import { getActiveModules } from '@/lib/modules/runtime';
import { getBrand } from '@/lib/brand/brand';
import { isContactFormEnabled } from '@/lib/contact';
import { getContentSections } from '@/lib/content/load';
import { sectionAnchors } from './_home/sections/content-sections';
// Menú y pie de cada plantilla: están en todas las páginas, así que su CSS carga desde el layout y no desde las rutas de cada plantilla.
import '@/components/templates/shell.css';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const [brand, contactEnabled, sections] = await Promise.all([getBrand(), isContactFormEnabled(), getContentSections()]);
  return (
    <div className="min-h-screen flex flex-col" data-template={brand.template} data-display-font={brand.theme?.fonts.display}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Saltar al contenido
      </a>
      <PublicNav modules={getActiveModules()} sticker={brand.template === 'feria' ? brand.sticker : ''} contact={contactEnabled} anchors={sectionAnchors(sections)} />
      <main id="main-content" className="flex-1 pt-16">{children}</main>
      <PublicFooter contact={contactEnabled} />
      <CookieBanner />
    </div>
  );
}
