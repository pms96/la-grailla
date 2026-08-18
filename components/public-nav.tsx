'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Menu, X, Music, ShoppingBag, Handshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/utils';

// Curva de ease-out reforzada (equivalente a --ease-out en globals.css).
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

const links = [
  { href: '/eventos', label: 'Eventos', icon: Music },
  { href: '/tienda', label: 'Tienda', icon: ShoppingBag },
  { href: '/sponsors', label: 'Sponsors', icon: Handshake },
];

export default function PublicNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname() ?? '';
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        scrolled
          ? 'bg-background/90 backdrop-blur-xl border-b border-border/50 shadow-lg'
          : 'bg-transparent'
      )}
    >
      <div className="max-w-[1200px] mx-auto flex items-center justify-between px-4 h-16">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 group">
          <Logo variant="white" className="h-8 sm:h-9" priority />
          <span className="sr-only">La Grailla</span>
          <span className="hidden sm:inline-flex brand-sticker text-[10px] text-lima border-lima/60 shadow-lima/30 py-0.5 px-2">
            GOOD VIBES
          </span>
        </Link>

        {/* Desktop */}
        <nav className="hidden md:flex items-center gap-1">
          {links.map((l) => {
            const isActive = pathname?.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href}>
                <Button
                  variant={isActive ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn(
                    'gap-2 font-medium transition-all',
                    isActive && 'bg-primary/10 text-primary'
                  )}
                >
                  <l.icon className="h-4 w-4" />
                  {l.label}
                </Button>
              </Link>
            );
          })}
        </nav>

        {/* Mobile toggle */}
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menú">
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </div>

      {/* Mobile menu — entrada y salida simétricas */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="md:hidden border-t border-border/50 bg-background/95 backdrop-blur-xl overflow-hidden"
          >
            <nav className="flex flex-col p-4 gap-1">
              {links.map((l) => (
                <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
                  <Button
                    variant={pathname?.startsWith(l.href) ? 'secondary' : 'ghost'}
                    className="w-full justify-start gap-2"
                  >
                    <l.icon className="h-4 w-4" />
                    {l.label}
                  </Button>
                </Link>
              ))}
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
