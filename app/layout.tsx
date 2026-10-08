import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { ChunkLoadErrorHandler } from '@/components/chunk-load-error-handler';
import { BrandProvider } from '@/components/brand-provider';
import { isContactFormEnabled } from '@/lib/contact';
import { getActiveModules } from '@/lib/modules/runtime';
import { tenantBlobPrefix } from '@/lib/tenant/blob';
import { absoluteBrandUrl, getBrand } from '@/lib/brand/brand';
import { fontVariableClasses } from '@/lib/brand/fonts';
import { BRAND_FONTS_ATTR, buildThemeCss } from '@/lib/brand/theme';
import Providers from './providers';

function neutralFavicon(name: string, color: string): string {
  const initial = (name.trim()[0] ?? '·').toUpperCase().replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="23" font-family="Arial,sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Sin cliente resuelto (una página que no es de ningún cliente) no hay prefijo: no debe tirar el layout.
function safeBlobPrefix(): string {
  try {
    return tenantBlobPrefix();
  } catch {
    return '';
  }
}

// La marca (título, iconos, colores, tipografías) es del cliente que pide la página: nada de esto puede quedar fijado en el build.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  const title = brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name;
  const og = absoluteBrandUrl(brand.ogImage);
  const isSeedIcons = brand.favicon === '/icon-32.png';
  return {
    title: { default: title, template: `%s | ${brand.name}` },
    description: brand.description || undefined,
    ...(!brand.favicon
      ? {
          // Sin favicon propio: una inicial sobre el color de marca. Si no, Next serviría el app/favicon.ico de La Grailla a otro cliente.
          icons: { icon: neutralFavicon(brand.name, brand.colors.primary) },
        }
      : {}),
    ...(brand.favicon
      ? {
          icons: isSeedIcons
            ? {
                icon: [
                  { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
                  { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                ],
                shortcut: '/icon-32.png',
                apple: '/apple-icon.png',
              }
            : { icon: brand.favicon, shortcut: brand.favicon, apple: brand.favicon },
        }
      : {}),
    openGraph: {
      title,
      description: brand.description || undefined,
      ...(og ? { images: [{ url: og }] } : {}),
    },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [brand, contactFormEnabled] = await Promise.all([getBrand(), isContactFormEnabled()]);
  // Sin tema guardado (La Grailla tal cual) no se añade nada: el CSS es el de globals.css.
  const themeCss = brand.theme ? buildThemeCss(brand.theme) : null;
  const fontsAttr = brand.theme ? { [BRAND_FONTS_ATTR]: '' } : {};
  return (
    <html lang="es" suppressHydrationWarning>
      {themeCss && (
        <head>
          <style id="brand-theme" dangerouslySetInnerHTML={{ __html: themeCss }} />
        </head>
      )}
      <body className={`${fontVariableClasses} font-sans`} {...fontsAttr}>
        <Providers>
          <BrandProvider value={{ name: brand.name, contactEmail: brand.contactEmail, organizer: brand.organizer, logoOnDark: brand.logoOnDark, logoOnLight: brand.logoOnLight, mode: brand.mode, contactFormEnabled, modules: getActiveModules(), blobPrefix: safeBlobPrefix() }}>
            <ThemeProvider attribute="class" defaultTheme={brand.mode} enableSystem disableTransitionOnChange>
              {children}
              <Toaster />
              <ChunkLoadErrorHandler />
            </ThemeProvider>
          </BrandProvider>
        </Providers>
      </body>
    </html>
  );
}
