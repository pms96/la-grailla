'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';
import { useBrand } from '@/components/brand-provider';

type LogoProps = {
  /** `auto` (por defecto) sigue el modo claro/oscuro; `white` y `black` fuerzan la versión para una superficie concreta (p. ej. un recibo blanco). */
  variant?: 'auto' | 'white' | 'black';
  className?: string;
  priority?: boolean;
  'aria-hidden'?: boolean;
};

function Mark({ src, name, hidden, className, priority }: { src: string; name: string; hidden?: boolean; className?: string; priority?: boolean }) {
  // Los logos propios de la instalación (/brand/…) pasan por next/image pero SIN el optimizador (`unoptimized`): son estáticos que ya se sirven con caché
  // y se muestran a ~50 px desde un PNG de 1200 px, así que el optimizador pediría anchos enormes. Los de Blob son URLs externas y van con <img>.
  if (src.startsWith('/')) {
    return (
      <Image src={src} alt={hidden ? '' : name} aria-hidden={hidden} width={1200} height={791} unoptimized priority={priority} className={cn('w-auto object-contain', className)} />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={hidden ? '' : name} aria-hidden={hidden} className={cn('w-auto object-contain', className)} />;
}

/**
 * Logo del cliente (Apariencia → logos). `white` es la versión para superficies OSCURAS y `black` para las CLARAS. Sin logo configurado se
 * muestra el nombre del cliente como marca de texto, nunca el de otro cliente.
 */
export function Logo({ variant = 'auto', className, priority, ...rest }: LogoProps) {
  const { name, logoOnDark, logoOnLight, mode } = useBrand();
  const hidden = rest['aria-hidden'];
  const dark = logoOnDark ?? logoOnLight;
  const light = logoOnLight ?? logoOnDark;

  if (!dark && !light) {
    return (
      <span aria-hidden={hidden} className={cn('inline-flex items-center font-display text-xl font-bold leading-none tracking-tight', className)}>
        {name}
      </span>
    );
  }
  if (variant === 'white') return <Mark src={dark!} name={name} hidden={hidden} className={className} priority={priority} />;
  if (variant === 'black') return <Mark src={light!} name={name} hidden={hidden} className={className} priority={priority} />;
  if (dark === light) return <Mark src={dark!} name={name} hidden={hidden} className={className} priority={priority} />;
  return (
    <>
      <Mark src={light!} name={name} hidden={hidden} className={cn('dark:hidden', className)} priority={priority && mode === 'light'} />
      <Mark src={dark!} name={name} hidden={hidden} className={cn('hidden dark:block', className)} priority={priority && mode !== 'light'} />
    </>
  );
}
