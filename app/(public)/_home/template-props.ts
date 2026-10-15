import type { HeroProps } from './hero';
import type { TemplateEvent } from './event-view';

/** Lo que cualquier portada de plantilla nueva (marquesina, galería…) recibe de la página: datos ya cargados y formateados, ningún acceso a BD. */
export type HomeTemplateProps = {
  brandName: string;
  hero: Pick<HeroProps, 'badge' | 'title' | 'subtitle' | 'primaryCta'>;
  events: readonly TemplateEvent[];
  loadError: boolean;
  hasEntradas: boolean;
  hasTienda: boolean;
  hasSponsors: boolean;
  contactEnabled: boolean;
  /** La tipografía de titulares del cliente tiene cursiva real (si no, una plantilla no la simula con una oblicua sintética). */
  italicAccent?: boolean;
  /** Textos editables en Configuración → Contenido; vacíos = cada plantilla usa su texto neutro. */
  copy: {
    shopTitle: string;
    shopSubtitle: string;
    aboutTitle: string;
    aboutText: string;
    sponsorsTitle: string;
    sponsorsSubtitle: string;
  };
};

/** Lo que recibe `/eventos` con una plantilla nueva. */
export type EventosTemplateProps = {
  brandName: string;
  events: readonly TemplateEvent[];
  loadError: boolean;
  italicAccent?: boolean;
};
