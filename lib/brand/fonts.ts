import { Fredoka, Space_Grotesk, Space_Mono, Inter, DM_Sans, Poppins, Montserrat, Playfair_Display, Bebas_Neue, Instrument_Serif } from 'next/font/google';

/* Catálogo cerrado de tipografías (lib/brand/theme.ts → FONT_CATALOG). `next/font` exige declarar cada familia en el ámbito del módulo y con
 * argumentos literales (no admite spread ni variables), así que no se pueden cargar familias arbitrarias por cliente: un cliente elige entre
 * estas. Las dos de La Grailla conservan su precarga; el resto va con `preload: false` (el navegador solo descarga el fichero de una familia
 * cuando la página la usa). */

const fredoka = Fredoka({ subsets: ['latin'], variable: '--f-fredoka', weight: ['400', '500', '600', '700'] });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--f-space-grotesk' });
const spaceMono = Space_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '700'] });

const inter = Inter({ subsets: ['latin'], variable: '--f-inter', preload: false, display: 'swap' });
const dmSans = DM_Sans({ subsets: ['latin'], variable: '--f-dm-sans', preload: false, display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], variable: '--f-poppins', weight: ['400', '500', '600', '700'], preload: false, display: 'swap' });
const montserrat = Montserrat({ subsets: ['latin'], variable: '--f-montserrat', preload: false, display: 'swap' });
const playfair = Playfair_Display({ subsets: ['latin'], variable: '--f-playfair-display', preload: false, display: 'swap' });
const bebas = Bebas_Neue({ subsets: ['latin'], variable: '--f-bebas-neue', weight: '400', preload: false, display: 'swap' });
// Solo existe en peso 400, con romana y cursiva (la plantilla «galería» usa la cursiva para destacar una palabra).
const instrumentSerif = Instrument_Serif({ subsets: ['latin'], variable: '--f-instrument-serif', weight: '400', style: ['normal', 'italic'], preload: false, display: 'swap' });

/** Clases que definen las variables de todas las familias del catálogo; van en <body>. */
export const fontVariableClasses = [fredoka, spaceGrotesk, spaceMono, inter, dmSans, poppins, montserrat, playfair, bebas, instrumentSerif]
  .map((f) => f.variable)
  .join(' ');
