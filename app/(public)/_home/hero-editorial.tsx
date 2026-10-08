import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/ui/animate';
import { Logo } from '@/components/logo';
import type { HeroProps } from './hero';

/**
 * Plantilla «editorial»: sobria. Tipografía grande, mucho aire, una sola imagen y sin adornos (sin degradados, ruido ni pegatinas).
 * Titular a la izquierda y, si hay cartel, a la derecha; si no, una marca de texto o el logo.
 */
export function HeroEditorial({ brandName, featured, badge, title, subtitle, primaryCta }: HeroProps) {
  const eyebrow = featured ? 'Próximo evento' : badge || brandName;
  // Un cliente sin eslogan ni textos de portada usa su nombre como titular: no se repite encima.
  const showEyebrow = eyebrow !== (featured ? featured.name : title);
  return (
    <section className="border-b border-border">
      <div className="max-w-[1200px] mx-auto px-4 py-16 md:py-24 grid gap-12 md:grid-cols-12 md:items-end">
        <FadeIn className={featured?.imageUrl ? 'md:col-span-7' : 'md:col-span-8'}>
          {showEyebrow && <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-6">{eyebrow}</p>}
          <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight leading-[1.02] text-balance">
            {featured ? featured.name : title}
          </h1>

          {featured ? (
            <>
              <p className="mt-6 text-lg text-muted-foreground">
                {[featured.dateLabel && <span key="d" className="inline-block first-letter:uppercase">{featured.dateLabel}</span>, featured.place && <span key="p">{featured.place}</span>]
                  .filter(Boolean)
                  .map((node, i) => (
                    <span key={i}>
                      {i > 0 && <span aria-hidden className="mx-2 text-border">/</span>}
                      {node}
                    </span>
                  ))}
                {featured.fromPrice != null && (
                  <span className="ml-3 font-mono text-sm text-foreground">desde {featured.fromPrice.toFixed(2)}€</span>
                )}
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-6">
                <Button asChild size="lg" className="h-12 px-7 text-base font-medium">
                  <Link href={`/eventos/${featured.slug}/comprar`}>Comprar entradas</Link>
                </Button>
                <Link href={`/eventos/${featured.slug}`} className="group inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
                  Ver ficha <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </>
          ) : (
            <>
              {subtitle && <p className="mt-6 max-w-xl text-lg text-muted-foreground">{subtitle}</p>}
              {primaryCta && (
                <div className="mt-10">
                  <Button asChild size="lg" className="h-12 px-7 text-base font-medium">
                    <Link href={primaryCta.href}>{primaryCta.label}</Link>
                  </Button>
                </div>
              )}
            </>
          )}
        </FadeIn>

        {featured?.imageUrl ? (
          <FadeIn className="md:col-span-5">
            {/* img nativo: las URLs de cartel pueden ser externas / uploads sin domain allowlist */}
            <img src={featured.imageUrl} alt={featured.name} className="w-full aspect-[4/5] object-cover rounded-md border border-border" />
          </FadeIn>
        ) : (
          <FadeIn className="hidden md:flex md:col-span-4 md:justify-end">
            <Logo className="h-16 opacity-90" aria-hidden />
          </FadeIn>
        )}
      </div>
    </section>
  );
}
