'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/* P0-11 · Casillas de aceptación del checkout. La obligatoriedad real la impone el servidor (app/api/orders y app/api/shop/orders); esto es
 * la interfaz: una casilla de condiciones de venta + privacidad (con enlaces que abren en pestaña nueva, para no perder el formulario) y,
 * si el evento tiene aviso de edad, otra con el aviso. El texto de las condiciones lo escribe cada cliente (o el borrador por defecto). */

export type LegalKind = 'entradas' | 'tienda';

export function LegalAcceptance({
  kind,
  accepted,
  onAcceptedChange,
  error,
  ageMessage,
  ageConfirmed,
  onAgeConfirmedChange,
  ageError,
  vatIncluded,
}: {
  kind: LegalKind;
  accepted: boolean;
  onAcceptedChange: (v: boolean) => void;
  error?: string;
  /** Aviso de edad del evento (null/ausente = no hay casilla de edad). */
  ageMessage?: string | null;
  ageConfirmed?: boolean;
  onAgeConfirmedChange?: (v: boolean) => void;
  ageError?: string;
  vatIncluded?: boolean;
}) {
  const link = 'text-primary underline underline-offset-2 hover:no-underline';
  return (
    <div className="space-y-3" data-testid="legal-acceptance">
      <div className="flex items-start gap-3">
        <Checkbox
          id={`terms-${kind}`}
          className="mt-0.5"
          checked={accepted}
          onCheckedChange={(v) => onAcceptedChange(v === true)}
          aria-invalid={!!error}
          aria-describedby={error ? `terms-${kind}-error` : undefined}
        />
        <Label htmlFor={`terms-${kind}`} className="text-sm font-normal leading-snug text-foreground/90">
          He leído y acepto las{' '}
          <a href={`/legal/condiciones-${kind}`} target="_blank" rel="noopener noreferrer" className={link}>
            condiciones de venta
          </a>{' '}
          y la{' '}
          <a href="/legal/privacidad" target="_blank" rel="noopener noreferrer" className={link}>
            política de privacidad
          </a>
          .
        </Label>
      </div>
      {error && (
        <p id={`terms-${kind}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {ageMessage && (
        <div className="flex items-start gap-3">
          <Checkbox
            id="age-confirmed"
            className="mt-0.5"
            checked={ageConfirmed === true}
            onCheckedChange={(v) => onAgeConfirmedChange?.(v === true)}
            aria-invalid={!!ageError}
            aria-describedby="age-confirmed-text"
          />
          <Label htmlFor="age-confirmed" id="age-confirmed-text" className="text-sm font-normal leading-snug text-foreground/90">
            {ageMessage}
          </Label>
        </div>
      )}
      {ageError && (
        <p className="text-sm text-destructive" role="alert">
          {ageError}
        </p>
      )}
      {vatIncluded && <p className="text-xs text-muted-foreground">Precios con IVA incluido.</p>}
    </div>
  );
}
