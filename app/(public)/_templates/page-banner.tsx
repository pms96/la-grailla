import { Marquee } from '@/components/ui/marquee';
import { Container } from '@/components/layouts/container';
import '@/components/templates/marquesina.css';
import '@/components/templates/galeria.css';
import '@/components/templates/tipo.css';
import type { TemplateKey } from '@/lib/brand/theme';
import { titleSize } from '../_home/event-view';
import { Words as MarquesinaWords } from '../_home/marquesina/home-marquesina';
import { GaleriaTitle } from '../_home/galeria/home-galeria';
import { TipoWords } from '../_home/tipo/home-tipo';
import { Composition } from '../_home/tipo/composition';
import { sentenceSize } from '../_home/estudio/home-estudio';
import { CineTransitions, posterTransitionName } from '../_home/cine/transitions';
import '@/components/templates/cine.css';
import '@/components/templates/drop.css';
import '@/components/templates/estudio.css';
import { cn } from '@/lib/utils';

/* Cabecera de las páginas interiores (ficha del evento, tienda, patrocinio, textos legales) de las plantillas nuevas. Hasta ahora esas páginas
 * llevaban siempre la cabecera de Feria (degradado, pegatina y textos fijos), así que un cliente con «marquesina», «galería» o «tipo» tenía una
 * portada propia y, al entrar en cualquier página, volvía a ver Feria. Feria y Editorial NO pasan por aquí: cada página conserva su cabecera.
 *
 * Todo el texto lo pone la página (nada fijo de ninguna marca). La compra y la sala de espera no la usan a propósito: van en modo «calma». */

export const BANNER_TEMPLATES = ['marquesina', 'galeria', 'tipo', 'estudio', 'cine', 'drop'] as const;
export type BannerTemplate = (typeof BANNER_TEMPLATES)[number];

/** ¿Esta plantilla tiene cabecera propia? Si no, la página sigue con la suya de siempre. */
export function hasBanner(template: TemplateKey): template is BannerTemplate {
  return (BANNER_TEMPLATES as readonly string[]).includes(template);
}

export type BannerFact = { label: string; value: string };

export type PageBannerProps = {
  template: BannerTemplate;
  brandName: string;
  title: string;
  eyebrow?: string;
  /** Frase bajo el titular. */
  lead?: string;
  /** Datos clave (fecha, lugar…): cada plantilla los presenta a su manera. */
  facts?: readonly BannerFact[];
  /** Cartel o foto. Marquesina y Galería la enseñan; «tipo» no usa fotos y pone una composición generada. */
  imageUrl?: string | null;
  /** Texto del que sale la composición de «tipo» (por defecto, el título). */
  seed?: string;
  /** La tipografía de titulares tiene cursiva real (la «galería» la usa en la última palabra). */
  italicAccent?: boolean;
  /** Versión baja, sin cinta ni imagen: para textos legales y páginas largas de lectura. */
  compact?: boolean;
};

/** `wide`: «tipo» usa una tipografía ancha y pesada, así que una palabra larga necesita un tamaño menor (ver `titleSize`). */
function size(title: string, compact: boolean, wide = false): 'l' | 'm' | 's' {
  return compact ? 's' : titleSize(title, wide);
}

function BannerMarquesina({ brandName, title, eyebrow, lead, facts = [], imageUrl, compact = false }: PageBannerProps) {
  const poster = !compact && imageUrl;
  const band = !compact ? facts.map((f) => f.value).filter(Boolean) : [];
  return (
    <section className="border-b border-border">
      <Container size="xl" className="pb-8 pt-8 md:pb-12 md:pt-14">
        <div className={poster ? 'grid gap-8 md:grid-cols-12 md:items-end' : undefined}>
          <div className={poster ? 'md:col-span-8' : undefined}>
            <p className="mq-eyebrow mb-4 md:mb-6">{eyebrow ?? brandName}</p>
            <h1 className="mq-title" data-size={size(title, compact)}>
              <MarquesinaWords text={title} />
            </h1>
            {lead && <p className="mt-6 max-w-xl text-lg text-muted-foreground">{lead}</p>}
            {facts.length > 0 && (
              <ul className="mt-6 flex flex-wrap gap-2">
                {facts.map((f) => (
                  <li key={f.label} className="border border-current px-2.5 py-1 text-xs font-medium uppercase tracking-wide">
                    <span className="sr-only">{f.label}: </span>
                    {f.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {poster && (
            <div className="md:col-span-4">
              <div className="aspect-[4/5] overflow-hidden border-2 border-foreground bg-muted">
                {/* img nativo: los carteles pueden ser subidas o URLs externas sin lista de dominios. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={`Cartel de ${title}`} className="h-full w-full object-cover" fetchPriority="high" />
              </div>
            </div>
          )}
        </div>
      </Container>
      {band.length > 0 && (
        <div className="mq-band">
          <Marquee items={band} duration={36} />
        </div>
      )}
    </section>
  );
}

function BannerGaleria({ brandName, title, eyebrow, lead, facts = [], imageUrl, italicAccent = false, compact = false }: PageBannerProps) {
  const photo = !compact && imageUrl;
  return (
    <section>
      <Container size="xl" className={compact ? 'pb-10 pt-10 md:pb-14 md:pt-16' : 'pb-12 pt-10 md:pb-20 md:pt-20'}>
        <p className="gl-label mb-6 md:mb-10">{eyebrow ?? brandName}</p>
        <h1 className="gl-title md:max-w-[92%]" data-size={size(title, compact)}>
          <GaleriaTitle text={title} italic={italicAccent} />
        </h1>
        {lead && <p className="mt-8 max-w-xl text-lg text-muted-foreground">{lead}</p>}
        {(facts.length > 0 || photo) && (
          <div className="mt-12 grid gap-10 md:mt-16 md:grid-cols-12 md:gap-x-8">
            <div className={photo ? 'md:col-span-5 md:self-end' : 'md:col-span-7'}>
              {facts.length > 0 && (
                <dl className="divide-y divide-border border-y border-border">
                  {facts.map((f) => (
                    <div key={f.label} className="grid grid-cols-[6rem_1fr] gap-4 py-3">
                      <dt className="gl-label pt-0.5">{f.label}</dt>
                      <dd className="text-base">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {photo && (
              <div className="md:col-span-6 md:col-start-7">
                <div className="gl-frame" data-hero>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt={`Cartel de ${title}`} fetchPriority="high" />
                </div>
              </div>
            )}
          </div>
        )}
      </Container>
    </section>
  );
}

function BannerTipo({ brandName, title, eyebrow, lead, facts = [], seed, compact = false }: PageBannerProps) {
  return (
    <section>
      <div className="tp-hero">
        <Container size="xl" className={compact ? 'pb-8 pt-8 md:pb-10 md:pt-10' : 'pb-10 pt-10 md:pb-16 md:pt-16'}>
          <div className={compact ? undefined : 'grid items-end gap-10 md:grid-cols-12 md:gap-x-8'}>
            <div className={compact ? undefined : 'md:col-span-8'}>
              <p className="tp-label mb-5 opacity-80 md:mb-8">{eyebrow ?? brandName}</p>
              <h1 className="tp-title" data-size={size(title, compact, true)}>
                <TipoWords text={title} />
              </h1>
              {lead && <p className="mt-6 max-w-xl text-lg opacity-90">{lead}</p>}
              {facts.length > 0 && (
                <ul className="mt-6 flex flex-wrap gap-2">
                  {facts.map((f) => (
                    <li key={f.label} className="border-2 border-current px-2.5 py-1 text-xs font-bold uppercase tracking-wide">
                      <span className="sr-only">{f.label}: </span>
                      {f.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!compact && (
              <div className="md:col-span-4">
                <Composition seed={seed ?? title} n={4} palette={['accent', 'onPrimary', 'ink']} className="block w-full max-w-[14rem] md:ml-auto md:max-w-none" />
              </div>
            )}
          </div>
        </Container>
      </div>
    </section>
  );
}

function BannerEstudio({ brandName, title, eyebrow, lead, facts = [], imageUrl, compact = false }: PageBannerProps) {
  const photo = !compact && imageUrl;
  return (
    <section>
      <div className={cn('mx-auto max-w-[1400px] px-5 md:px-10', compact ? 'pb-8 pt-10 md:pb-12 md:pt-16' : 'pb-12 pt-12 md:pb-20 md:pt-24')}>
        <div className={photo ? 'grid gap-10 md:grid-cols-12 md:items-end md:gap-x-8' : undefined}>
          <div className={photo ? 'md:col-span-7' : undefined}>
            <p className="es-label mb-6 md:mb-10">{eyebrow ?? brandName}</p>
            <h1 className="es-title" data-size={compact ? 's' : sentenceSize(title)}>
              {title}
            </h1>
            {lead && <p className="mt-6 max-w-xl text-lg text-muted-foreground">{lead}</p>}
          </div>
          {photo && (
            <div className="md:col-span-5">
              <div className="aspect-[4/3] overflow-hidden bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={`Cartel de ${title}`} className="h-full w-full object-cover" fetchPriority="high" />
              </div>
            </div>
          )}
        </div>
        {facts.length > 0 && (
          <dl className="mt-10 grid gap-x-10 gap-y-5 border-t border-border pt-6 sm:grid-cols-2 md:mt-14 md:grid-cols-4">
            {facts.map((f) => (
              <div key={f.label}>
                <dt className="es-label">{f.label}</dt>
                <dd className="mt-1.5 text-base">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

/** «cine»: título grande y, en la ficha del evento, el cartel a la derecha con el mismo nombre de transición que su tarjeta (`seed` es el slug del
 *  evento): al llegar desde la cartelera, el cartel crece de la tarjeta a este sitio. */
function BannerCine({ brandName, title, eyebrow, lead, facts = [], imageUrl, seed, compact = false }: PageBannerProps) {
  const poster = !compact && imageUrl;
  return (
    <section>
      <CineTransitions />
      <div className={cn('mx-auto max-w-[1600px] px-5 md:px-10', compact ? 'pb-8 pt-10 md:pb-12 md:pt-16' : 'pb-12 pt-12 md:pb-20 md:pt-20')}>
        <div className={poster ? 'grid gap-10 md:grid-cols-12 md:items-end md:gap-x-10' : undefined}>
          <div className={poster ? 'md:col-span-7 lg:col-span-8' : undefined}>
            <p className="cn-label mb-5 md:mb-8">{eyebrow ?? brandName}</p>
            <h1 className="cn-title" data-size={compact ? 's' : titleSize(title)}>
              {title}
            </h1>
            {lead && <p className="mt-6 max-w-xl text-lg text-muted-foreground">{lead}</p>}
            {facts.length > 0 && (
              <dl className="mt-8 grid gap-x-10 gap-y-5 border-t border-border pt-6 sm:grid-cols-2 md:mt-12 xl:grid-cols-4">
                {facts.map((f) => (
                  <div key={f.label}>
                    <dt className="cn-label">{f.label}</dt>
                    <dd className="mt-1.5 text-base">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {poster && (
            <div className="md:col-span-5 lg:col-span-4">
              <div className="cn-poster" style={seed ? { ['viewTransitionName' as string]: posterTransitionName(seed) } : undefined}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={`Cartel de ${title}`} fetchPriority="high" />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** «drop»: bloque de color con el título grande, los datos como etiquetas con borde y, si hay imagen (el cartel del evento), a la derecha. */
function BannerDrop({ brandName, title, eyebrow, lead, facts = [], imageUrl, compact = false }: PageBannerProps) {
  const photo = !compact && imageUrl;
  return (
    <section data-tone="primary">
      <div className={cn('mx-auto max-w-[1400px] px-5 md:px-10', compact ? 'pb-8 pt-10 md:pb-12 md:pt-14' : 'pb-10 pt-10 md:pb-16 md:pt-16')}>
        <div className={photo ? 'grid items-center gap-8 md:grid-cols-12 md:gap-x-10' : undefined}>
          <div className={photo ? 'md:col-span-8' : undefined}>
            <p className="dp-label mb-5 md:mb-8">{eyebrow ?? brandName}</p>
            <h1 className="dp-title" data-size={compact ? 's' : titleSize(title)}>
              {title}
            </h1>
            {lead && <p className="mt-6 max-w-xl text-lg opacity-90">{lead}</p>}
            {facts.length > 0 && (
              <ul className="mt-6 flex flex-wrap gap-2">
                {facts.map((f) => (
                  <li key={f.label} className="rounded border-2 border-current px-3 py-1 text-xs font-bold uppercase tracking-wide">
                    <span className="sr-only">{f.label}: </span>
                    {f.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {photo && (
            <div className="md:col-span-4">
              <div className="dp-card-media" data-tone="accent">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={`Cartel de ${title}`} fetchPriority="high" />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function PageBanner(props: PageBannerProps) {
  switch (props.template) {
    case 'drop':
      return <BannerDrop {...props} />;
    case 'cine':
      return <BannerCine {...props} />;
    case 'estudio':
      return <BannerEstudio {...props} />;
    case 'galeria':
      return <BannerGaleria {...props} />;
    case 'tipo':
      return <BannerTipo {...props} />;
    default:
      return <BannerMarquesina {...props} />;
  }
}
