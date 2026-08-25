import PublicNav from '@/components/public-nav';
import PublicFooter from '@/components/public-footer';
import CookieBanner from '@/components/cookie-banner';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Saltar al contenido
      </a>
      <PublicNav />
      <main id="main-content" className="flex-1 pt-16">{children}</main>
      <PublicFooter />
      <CookieBanner />
    </div>
  );
}
