import Image from 'next/image';
import { cn } from '@/lib/utils';

type LogoProps = {
  variant?: 'white' | 'black';
  className?: string;
  priority?: boolean;
  'aria-hidden'?: boolean;
};

/**
 * Wordmark oficial de La Grailla (lettering a mano, no es tipografía del sistema).
 * `white` para superficies oscuras (nav, footer, hero); `black` para superficies claras.
 */
export function Logo({ variant = 'white', className, priority, ...rest }: LogoProps) {
  const src = variant === 'white' ? '/brand/logo-white.png' : '/brand/logo-black.png';
  const hidden = rest['aria-hidden'];
  return (
    <Image
      src={src}
      alt={hidden ? '' : 'La Grailla'}
      aria-hidden={hidden}
      width={1200}
      height={791}
      priority={priority}
      className={cn('w-auto object-contain', className)}
    />
  );
}
