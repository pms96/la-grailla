// Preguntas del formulario guiado del portal de sponsors — compartidas entre
// la UI (app/(public)/patrocinadores/.../sponsor-portal-client.tsx) y el
// contexto que se manda a Abacus.AI (lib/abacus-ai-adapter.ts), para que
// ambos hablen de las mismas preguntas con las mismas etiquetas.
//
// Antes eran campos de texto libre con placeholders vagos ("Ej. minimalista,
// retro...") — la mayoría de sponsors escribían una palabra suelta, y esa
// falta de detalle se notaba directamente en prompts genéricos. Ahora son
// opciones concretas (con un "Otro" para no encorsetar a nadie) pensadas
// para dar al prompt algo específico con lo que trabajar.
export type GuidedQuestion = {
  key: string;
  label: string;
  type: 'select' | 'text';
  options?: string[];
  placeholder?: string;
  helperText?: string;
};

export const SPONSOR_GUIDED_QUESTIONS: GuidedQuestion[] = [
  {
    key: 'transicionLogo',
    label: 'Transición del logo',
    type: 'select',
    helperText: 'Cómo quieres que "aparezca" tu logo — es la parte más importante del vídeo.',
    options: [
      'Partículas de luz que se ensamblan formando el logo',
      'Fragmentos o piezas que encajan hasta formar el logo',
      'Barrido de luz que revela el logo de un lado a otro',
      'Zoom cinematográfico que se acerca hasta el logo',
      'Rotación 3D suave que presenta el logo',
      'Tinta o humo que se condensa formando el logo',
      'Ondas de energía que emergen desde el logo',
    ],
  },
  {
    key: 'estiloVisual',
    label: 'Estilo visual',
    type: 'select',
    options: [
      'Minimalista y limpio',
      'Lujo y elegancia',
      'Urbano y street',
      'Retro-vintage (80s/90s)',
      'Neón y cyberpunk',
      'Natural y orgánico',
      'Corporativo y serio',
      'Divertido y colorista',
    ],
  },
  {
    key: 'ambiente',
    label: 'Ambiente / vibra deseada',
    type: 'select',
    options: [
      'Enérgico y festivo',
      'Elegante y sofisticado',
      'Misterioso e intrigante',
      'Cálido y cercano',
      'Épico y cinematográfico',
      'Relajado y aspiracional',
    ],
  },
  {
    key: 'entorno',
    label: 'Entorno / fondo',
    type: 'select',
    helperText: 'Dónde "vive" el logo en el vídeo.',
    options: [
      'Fondo oscuro abstracto con partículas',
      'Superficie reflectante (mármol, cristal, metal)',
      'Paisaje urbano nocturno',
      'Estudio limpio de producto',
      'Ambiente de feria o fiesta',
    ],
  },
  {
    key: 'ritmo',
    label: 'Ritmo',
    type: 'select',
    options: [
      'Pausado y cinematográfico',
      'Dinámico y rápido',
      'Creciente (empieza lento, termina enérgico)',
      'Constante y elegante',
    ],
  },
  {
    key: 'enfoqueMarca',
    label: 'Enfoque de marca',
    type: 'select',
    options: [
      'Calidad y artesanía',
      'Innovación y tecnología',
      'Tradición y confianza',
      'Diversión y cercanía',
      'Exclusividad y prestigio',
    ],
  },
  {
    key: 'coloresClave',
    label: 'Colores clave de tu marca',
    type: 'text',
    placeholder: 'Ej. dorado #C9A227 y negro',
    helperText: 'Nombra los colores (y su código hex si lo tienes) — así el vídeo respeta tu paleta real.',
  },
];

export const CUSTOM_OPTION_LABEL = 'Otro (especifica)';
