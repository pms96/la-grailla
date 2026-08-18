import { Space_Grotesk, Fredoka, Space_Mono } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { ChunkLoadErrorHandler } from '@/components/chunk-load-error-handler';
import Providers from './providers';

export const dynamic = 'force-dynamic';

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-sans' });
const fredoka = Fredoka({ subsets: ['latin'], variable: '--font-display', weight: ['400', '500', '600', '700'] });
const spaceMono = Space_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '700'] });

export const metadata = {
  title: 'La Grailla — Good Vibes & Eventos',
  description: 'La Grailla: caseta de feria, eventos, fiestas y las mejores noches. ¡Good Vibes! ¿Te vienes?',
  icons: {
    icon: [
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/icon-32.png',
    apple: '/apple-icon.png',
  },
  openGraph: {
    title: 'La Grailla — Eventos',
    description: 'Descubre los mejores eventos y fiestas con La Grailla.',
    images: [{ url: '/og-image.png' }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className={`${spaceGrotesk.variable} ${fredoka.variable} ${spaceMono.variable} font-sans`}>
        <Providers>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster />
            <ChunkLoadErrorHandler />
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
