import Link from 'next/link';
import { Logo } from '@/components/logo';

export default function PublicFooter() {
  return (
    <footer className="relative border-t border-border/30 bg-card/80">
      <div className="max-w-[1200px] mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Brand */}
          <div className="flex flex-col items-center md:items-start gap-2">
            <Logo variant="white" className="h-6" />
            <p className="text-sm text-muted-foreground text-center md:text-left">
              Caseta de feria · Eventos · Good Vibes 💜
            </p>
          </div>

          {/* Links */}
          <div className="flex flex-col items-center md:items-end gap-3">
            <div className="flex gap-6 text-sm font-medium">
              <Link href="/eventos" className="text-muted-foreground hover:text-primary transition-colors">Eventos</Link>
              <Link href="/tienda" className="text-muted-foreground hover:text-primary transition-colors">Tienda</Link>
              <Link href="/sponsors" className="text-muted-foreground hover:text-primary transition-colors">Sponsors</Link>
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground/80">
              <Link href="/legal/aviso-legal" className="hover:text-primary transition-colors">Aviso legal</Link>
              <Link href="/legal/privacidad" className="hover:text-primary transition-colors">Privacidad</Link>
              <Link href="/legal/cookies" className="hover:text-primary transition-colors">Cookies</Link>
            </div>
          </div>

          {/* Copy */}
          <p className="text-xs text-muted-foreground">
            <span suppressHydrationWarning>&copy; 2025 Grupo La Grailla. Hecho con 🔥 en Málaga.</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
