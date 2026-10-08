/** Lo que necesita cualquier portada (de cualquier plantilla) para pintar la cabecera. */
export type HeroProps = {
  brandName: string;
  /** Próximo evento publicado (solo con el módulo Entradas). */
  featured: {
    name: string;
    slug: string;
    imageUrl: string | null;
    dateLabel: string;
    place: string;
    fromPrice: number | null;
  } | null;
  /** Textos editables en Configuración → Contenido; vacíos = se usan los de la marca. */
  badge: string;
  title: string;
  subtitle: string;
  /** Adónde lleva el botón principal cuando no hay evento destacado: /eventos, /tienda o el formulario de contacto. */
  /** null = no hay a dónde llevar (sin Entradas, Tienda ni formulario de contacto): no se pinta botón. */
  primaryCta: { href: string; label: string; icon: 'ticket' | 'shop' | 'mail' } | null;
  /** Imagen decorativa (solo La Grailla). */
  stickerImage: string | null;
};
