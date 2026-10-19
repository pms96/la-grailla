import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import '@/components/templates/marquesina.css';
import '@/components/templates/galeria.css';
import '@/components/templates/tipo.css';
import { cn } from '@/lib/utils';
import type { TemplateKey } from '@/lib/brand/theme';
import { SECTION_DEFS, hasContent, type ContentSection, type SectionItem, type SectionKind } from '@/lib/content/sections';
import { Composition } from '../tipo/composition';
import { ProjectIndex } from '../estudio/project-index';

/* Las secciones de contenido que escribe el cliente (servicios, proyectos, equipo, preguntas frecuentes) con el aire de cada plantilla.
 * Es el MISMO contenido y la MISMA estructura en todas; cambian la tipografía, los filetes y el tamaño de los titulares, siempre con las
 * clases de cada plantilla (nada de colores ni fuentes fijos: todo sale de los tokens del tema). Una sección sin elementos no pinta nada.
 *
 * Dónde van en la portada: «antes» de «Sobre nosotros» los servicios y los proyectos (lo que haces), «después» el equipo y las preguntas
 * frecuentes (quién eres y qué dudas resolver antes de escribir). */

export type SectionsData = Partial<Record<SectionKind, ContentSection>>;
export type SectionSlot = 'before-about' | 'after-about';

export const SLOT_KINDS: Readonly<Record<SectionSlot, readonly SectionKind[]>> = {
  'before-about': ['servicios', 'proyectos'],
  'after-about': ['equipo', 'faq'],
};

/** Enlaces del menú a las secciones que existen, en el orden en que salen en la portada. */
export function sectionAnchors(sections: SectionsData): { href: string; label: string }[] {
  return [...SLOT_KINDS['before-about'], ...SLOT_KINDS['after-about']]
    .filter((k) => hasContent(sections[k]))
    .map((k) => ({ href: `/#${SECTION_DEFS[k].anchor}`, label: sections[k]!.title || SECTION_DEFS[k].defaultTitle }));
}

type Look = {
  /** Contenedor de la sección (ancho, márgenes, filete superior). */
  wrap: string;
  title: string;
  intro: string;
  itemTitle: string;
  meta: string;
  text: string;
  /** Color del filete entre elementos de una lista. */
  rule: string;
  /** Marco de las imágenes. */
  frame: string;
};

const FERIA: Look = {
  wrap: 'mx-auto max-w-[1200px] px-4 py-16 md:py-20',
  title: 'font-display text-3xl font-bold tracking-tight text-balance md:text-4xl',
  intro: 'mt-3 max-w-prose text-lg text-muted-foreground',
  itemTitle: 'font-display text-xl font-semibold tracking-tight',
  meta: 'font-mono text-sm text-foreground',
  text: 'text-muted-foreground',
  rule: 'border-border',
  frame: 'rounded-xl bg-muted',
};

const LOOKS: Record<TemplateKey, Look> = {
  feria: FERIA,
  editorial: { ...FERIA, title: 'font-display text-3xl font-semibold tracking-tight text-balance md:text-4xl', meta: 'text-sm font-medium text-muted-foreground', frame: 'bg-muted' },
  marquesina: {
    wrap: 'mx-auto max-w-[1600px] border-t border-border px-4 py-12 md:px-8 md:py-20',
    title: 'font-display text-4xl uppercase leading-none md:text-6xl',
    intro: 'mt-3 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'font-display text-2xl uppercase leading-none',
    meta: 'mq-eyebrow',
    text: 'text-muted-foreground',
    rule: 'border-border',
    frame: 'border-2 border-foreground bg-muted',
  },
  galeria: {
    wrap: 'mx-auto max-w-[1400px] border-t border-border px-5 py-14 md:px-10 md:py-24',
    title: 'gl-serif text-4xl md:text-6xl',
    intro: 'mt-4 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'gl-serif text-2xl md:text-3xl',
    meta: 'gl-label',
    text: 'text-muted-foreground',
    rule: 'border-border',
    frame: 'bg-muted',
  },
  drop: {
    wrap: 'mx-auto max-w-[1400px] px-5 py-14 md:px-10 md:py-24',
    title: 'dp-heading',
    intro: 'mt-4 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'font-display text-2xl font-bold tracking-tight md:text-3xl',
    meta: 'dp-label',
    text: 'text-muted-foreground',
    rule: 'border-border',
    frame: 'rounded-lg bg-muted',
  },
  cine: {
    wrap: 'mx-auto max-w-[1600px] border-t border-border px-5 py-14 md:px-10 md:py-24',
    title: 'cn-heading',
    intro: 'mt-4 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'font-display text-2xl font-medium tracking-tight md:text-3xl',
    meta: 'cn-label',
    text: 'text-muted-foreground',
    rule: 'border-border',
    frame: 'bg-muted',
  },
  estudio: {
    wrap: 'mx-auto max-w-[1400px] border-t border-border px-5 py-14 md:px-10 md:py-24',
    title: 'es-heading',
    intro: 'mt-4 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'font-display text-2xl font-medium tracking-tight md:text-3xl',
    meta: 'font-mono text-xs uppercase tracking-wider text-muted-foreground',
    text: 'text-muted-foreground',
    rule: 'border-border',
    frame: 'bg-muted',
  },
  tipo: {
    wrap: 'mx-auto max-w-[1600px] px-4 py-14 md:px-8 md:py-24',
    title: 'tp-heading text-5xl md:text-7xl',
    intro: 'mt-3 max-w-xl text-lg text-muted-foreground',
    itemTitle: 'tp-heading text-2xl md:text-3xl',
    meta: 'tp-label',
    text: 'text-muted-foreground',
    rule: 'border-foreground',
    frame: 'border-[3px] border-foreground bg-muted',
  },
};

/** Los filetes de «tipo» son gruesos; los del resto, finos. */
const ruleTop = (t: TemplateKey) => (t === 'tipo' ? 'border-t-[3px]' : 'border-t');
const ruleBottom = (t: TemplateKey) => (t === 'tipo' ? 'border-b-[3px]' : 'border-b');

const isExternal = (href: string) => /^https:\/\//i.test(href);

/** Título de un elemento: con enlace si lo tiene. En una tarjeta el enlace se estira (`stretch`) para que toda ella sea clicable. */
function ItemTitle({ item, className, stretch = false }: { item: SectionItem; className: string; stretch?: boolean }) {
  if (!item.href) return <h3 className={className}>{item.title}</h3>;
  const external = isExternal(item.href);
  return (
    <h3 className={className}>
      <a
        href={item.href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className={cn(
          'underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
          stretch && 'after:absolute after:inset-0'
        )}
      >
        {item.title}
        {external && <span className="sr-only"> (se abre en otra pestaña)</span>}
      </a>
    </h3>
  );
}

function Shell({ kind, section, template, layout, children }: { kind: SectionKind; section: ContentSection; template: TemplateKey; layout: 'split' | 'stack'; children: ReactNode }) {
  const look = LOOKS[template];
  const def = SECTION_DEFS[kind];
  const id = `${def.anchor}-titulo`;
  const head = (
    <div>
      <h2 id={id} className={look.title}>
        {section.title || def.defaultTitle}
      </h2>
      {section.intro && <p className={look.intro}>{section.intro}</p>}
    </div>
  );
  return (
    <section id={def.anchor} aria-labelledby={id} className={cn('scroll-mt-20', look.wrap)}>
      {layout === 'split' ? (
        <div className="grid gap-8 md:grid-cols-12 md:gap-x-8">
          <div className="md:col-span-4">{head}</div>
          <div className="md:col-span-8">{children}</div>
        </div>
      ) : (
        <div className="space-y-10 md:space-y-14">
          {head}
          {children}
        </div>
      )}
    </section>
  );
}

function Servicios({ section, template }: { section: ContentSection; template: TemplateKey }) {
  const look = LOOKS[template];
  return (
    <Shell kind="servicios" section={section} template={template} layout="split">
      <ul>
        {section.items.map((item, i) => (
          <li key={i} className={cn('relative grid gap-3 py-7 sm:grid-cols-[1fr_auto] sm:gap-x-8', ruleTop(template), look.rule, i === section.items.length - 1 && ruleBottom(template))}>
            <div className="min-w-0">
              <ItemTitle item={item} className={look.itemTitle} stretch />
              {item.text && <p className={cn('mt-3 max-w-prose whitespace-pre-line', look.text)}>{item.text}</p>}
            </div>
            {item.meta && <p className={cn('sm:text-right', look.meta)}>{item.meta}</p>}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

/** Imagen de una tarjeta. «tipo» no usa fotos y pone una forma generada; el resto, la imagen subida o, si a ese elemento le falta y a otros no,
 *  sus iniciales (un hueco vacío parecería un fallo). */
function Thumb({ item, template, ratio }: { item: SectionItem; template: TemplateKey; ratio: string }) {
  const look = LOOKS[template];
  return (
    <div className={cn('overflow-hidden', ratio, look.frame)}>
      {item.imageUrl ? (
        // img nativo: son subidas del cliente a Blob (la CSP ya las admite) y no hay lista de dominios de next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : template === 'tipo' ? (
        <Composition seed={item.title} n={3} palette={['accent', 'primary', 'ink']} className="block h-full w-full" />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-display text-5xl text-muted-foreground" aria-hidden>
          {initials(item.title)}
        </div>
      )}
    </div>
  );
}

/** ¿Lleva marco de imagen esta sección? Si nadie ha subido ninguna imagen, las tarjetas son solo de texto (salvo «tipo», que dibuja sus formas). */
const showFrames = (items: readonly SectionItem[], template: TemplateKey) => template === 'tipo' || items.some((i) => i.imageUrl);

function Proyectos({ section, template }: { section: ContentSection; template: TemplateKey }) {
  const look = LOOKS[template];
  const frames = showFrames(section.items, template);
  // «estudio»: los proyectos son su índice (filas grandes con la imagen siguiendo al cursor), no una rejilla de tarjetas.
  if (template === 'estudio') {
    return (
      <Shell kind="proyectos" section={section} template={template} layout="stack">
        <ProjectIndex items={section.items} />
      </Shell>
    );
  }
  return (
    <Shell kind="proyectos" section={section} template={template} layout="stack">
      <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {section.items.map((item, i) => (
          <li key={i} className="relative">
            {frames && <Thumb item={item} template={template} ratio="aspect-[4/3]" />}
            <div className={frames ? 'mt-4' : cn('pt-5', ruleTop(template), look.rule)}>
              {item.meta && <p className={cn('mb-1.5', look.meta)}>{item.meta}</p>}
              <ItemTitle item={item} className={look.itemTitle} stretch />
              {item.text && <p className={cn('mt-2 whitespace-pre-line', look.text)}>{item.text}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

/** Iniciales para quien no tiene foto: las de las dos primeras palabras del nombre. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');

function Equipo({ section, template }: { section: ContentSection; template: TemplateKey }) {
  const look = LOOKS[template];
  const frames = showFrames(section.items, template);
  return (
    <Shell kind="equipo" section={section} template={template} layout="stack">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:gap-x-6 md:gap-y-10 lg:grid-cols-4">
        {section.items.map((item, i) => (
          <li key={i} className={frames ? undefined : cn('pt-5', ruleTop(template), look.rule)}>
            {frames && <Thumb item={item} template={template} ratio="aspect-square" />}
            <h3 className={cn(frames && 'mt-4', look.itemTitle)}>{item.title}</h3>
            {item.meta && <p className={cn('mt-1.5', look.meta)}>{item.meta}</p>}
            {item.text && <p className={cn('mt-3 whitespace-pre-line text-sm', look.text)}>{item.text}</p>}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Faq({ section, template }: { section: ContentSection; template: TemplateKey }) {
  const look = LOOKS[template];
  return (
    <Shell kind="faq" section={section} template={template} layout="split">
      <div>
        {section.items.map((item, i) => (
          // <details> nativo: se abre con teclado y lector de pantalla sin JavaScript, y el contenido está en el HTML aunque esté cerrado.
          <details key={i} className={cn('group', ruleTop(template), look.rule, i === section.items.length - 1 && ruleBottom(template))}>
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <h3 className={cn(look.itemTitle, 'text-pretty')}>{item.title}</h3>
              <Plus className="mt-1 h-5 w-5 shrink-0 transition-transform duration-200 ease-out group-open:rotate-45 motion-reduce:transition-none" aria-hidden />
            </summary>
            {item.text && <p className={cn('max-w-prose whitespace-pre-line pb-6', look.text)}>{item.text}</p>}
          </details>
        ))}
      </div>
    </Shell>
  );
}

/** Las secciones de un tramo de la portada (antes o después de «Sobre nosotros»), o las que pida `kinds` en ese orden (la plantilla «estudio»
 *  pone los proyectos antes que los servicios). Sin contenido en ninguna, no pinta nada. */
export function ContentSections({ template, sections, slot = 'before-about', kinds }: { template: TemplateKey; sections?: SectionsData; slot?: SectionSlot; kinds?: readonly SectionKind[] }) {
  if (!sections) return null;
  return (
    <>
      {(kinds ?? SLOT_KINDS[slot]).map((kind) => {
        const section = sections[kind];
        if (!hasContent(section)) return null;
        switch (kind) {
          case 'servicios':
            return <Servicios key={kind} section={section} template={template} />;
          case 'proyectos':
            return <Proyectos key={kind} section={section} template={template} />;
          case 'equipo':
            return <Equipo key={kind} section={section} template={template} />;
          case 'faq':
            return <Faq key={kind} section={section} template={template} />;
        }
      })}
    </>
  );
}
