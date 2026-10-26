import Link from 'next/link';
import Image from 'next/image';
import { Calendar, MapPin, Mail, ShoppingBag, Sparkles, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FadeIn } from '@/components/ui/animate';
import { Logo } from '@/components/logo';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import type { HeroProps } from './hero';

const CTA_ICONS = { ticket: Ticket, shop: ShoppingBag, mail: Mail } as const;

/** Plantilla «feria»: cartel festivo (degradados, ruido, pegatinas de borde grueso, botones redondeados). Es la portada de La Grailla. */
export function HeroFeria({ brandName, featured, badge, title, subtitle, primaryCta, stickerImage }: HeroProps) {
  const CtaIcon = primaryCta ? CTA_ICONS[primaryCta.icon] : null;
  const buyHref = featured ? `/eventos/${featured.slug}/comprar` : '/eventos';
  return (
    <section className="relative overflow-hidden min-h-[85vh] flex items-end md:items-center">
      {featured?.imageUrl ? (
        <>
          {/* img nativo: las URLs de cartel pueden ser externas / uploads sin domain allowlist */}
          <img {...blobImgProps(featured.imageUrl, { sizes: IMG_SIZES.full })} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-background/30" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 hero-gradient" />
          <div className="absolute inset-0 texture-noise" />
          <div className="absolute top-20 right-10 w-32 h-32 rounded-full bg-lima/10 blur-3xl" />
          <div className="absolute bottom-20 left-10 w-40 h-40 rounded-full bg-neon-pink/8 blur-3xl" />
        </>
      )}

      {!featured && stickerImage && (
        <Image
          src={stickerImage}
          alt=""
          width={441}
          height={254}
          aria-hidden
          className="hidden lg:block absolute top-24 right-[8%] w-40 h-auto rotate-[8deg] drop-shadow-2xl select-none pointer-events-none"
        />
      )}

      <div className="relative max-w-[1200px] mx-auto px-4 py-24 md:py-32 w-full">
        <FadeIn>
          <div className="mb-6">
            <Logo className="h-8 sm:h-9" priority />
            <span className="sr-only">{brandName}</span>
          </div>

          {featured ? (
            <>
              <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-5 gap-1.5">
                <Sparkles className="h-4 w-4" /> PRÓXIMA NOCHE
              </div>
              <h1 className="font-display text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight leading-[0.92] max-w-3xl mb-5">
                {featured.name}
              </h1>
              <div className="flex flex-wrap gap-3 mb-8 text-sm text-muted-foreground">
                {featured.dateLabel && (
                  <Badge variant="secondary" className="gap-1.5 font-normal">
                    <Calendar className="h-3.5 w-3.5" />
                    <span className="font-mono text-xs capitalize">{featured.dateLabel}</span>
                  </Badge>
                )}
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <MapPin className="h-3.5 w-3.5" />
                  {featured.place}
                </Badge>
                {featured.fromPrice != null && (
                  <Badge variant="secondary" className="text-primary font-semibold">
                    Desde {featured.fromPrice.toFixed(2)}€
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Link href={buyHref}>
                  <Button size="lg" className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25">
                    <Ticket className="h-5 w-5" />
                    Comprar entradas
                  </Button>
                </Link>
                <Link
                  href={`/eventos/${featured.slug}`}
                  className="text-sm font-display font-semibold text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
                >
                  Ver ficha
                </Link>
              </div>
            </>
          ) : (
            <>
              {badge && (
                <div className="inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8 gap-1.5">
                  <Sparkles className="h-4 w-4" />
                  {badge}
                </div>
              )}
              <h1 className="mb-6 font-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight max-w-2xl leading-[0.95]">{title}</h1>
              {subtitle && <p className="text-base md:text-lg text-muted-foreground/70 max-w-xl mb-10">{subtitle}</p>}
              {primaryCta && CtaIcon && (
                <Link href={primaryCta.href}>
                  <Button size="lg" className="gap-2 text-base font-display font-semibold px-8 h-12 rounded-full shadow-lg shadow-primary/25">
                    <CtaIcon className="h-5 w-5" />
                    {primaryCta.label}
                  </Button>
                </Link>
              )}
            </>
          )}
        </FadeIn>
      </div>
    </section>
  );
}
