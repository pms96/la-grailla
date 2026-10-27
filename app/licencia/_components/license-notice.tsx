import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LicenseContact } from '@/components/license-contact';
import type { ProviderContact } from '@/lib/license-support';
import { LicenseSignOut } from './sign-out-button';

/* Lo que se ve cuando la licencia de un cliente bloquea el panel (402) o el sitio entero (503). Presentación pura: la página le pasa la fase, el
 * rol de quien mira (si hay sesión), si el escáner sigue disponible y el contacto del proveedor. Cada rol tiene una salida:
 *   - sin sesión: la web (solo con el panel bloqueado) o el acceso del personal;
 *   - con sesión (administrador o taquilla): el escáner de entradas, que sigue permitido, y cerrar sesión. */

export type LicenseNoticeProps = {
  phase: 'PANEL_BLOCKED' | 'BLOCKED';
  /** La Grailla conserva su cabecera de Feria (degradado y pegatina); el resto de clientes, una sobria. */
  legacy: boolean;
  brandName: string;
  /** Rol de quien mira, o null si no ha iniciado sesión. */
  role: 'ADMIN' | 'TAQUILLA' | null;
  /** ¿El cliente tiene escáner de entradas (módulo Entradas)? */
  scanner: boolean;
  contact: ProviderContact;
};

export function LicenseNotice({ phase, legacy, brandName, role, scanner, contact }: LicenseNoticeProps) {
  const panelOnly = phase === 'PANEL_BLOCKED';
  const pill = 'rounded-full shadow-lg';
  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {legacy && (
        <>
          <div className="absolute inset-0 hero-gradient" />
          <div className="absolute inset-0 texture-noise" />
        </>
      )}
      <div className="relative max-w-lg mx-auto px-4 py-24 text-center">
        <div
          className={
            legacy
              ? 'inline-flex brand-sticker text-sm text-lima border-lima/60 shadow-lima/30 mb-8'
              : 'inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm font-medium text-muted-foreground mb-8'
          }
        >
          <Lock className="h-4 w-4" />
          {panelOnly ? 'Licencia vencida' : 'Fuera de servicio'}
        </div>
        {brandName && <p className="mb-3 text-sm font-medium text-muted-foreground">{brandName}</p>}
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight mb-4 leading-[0.95]">
          {panelOnly ? 'El panel está bloqueado' : 'Este sitio no está disponible'}
        </h1>
        <div className="space-y-3 text-lg text-muted-foreground mb-10">
          {panelOnly ? (
            <p>
              La licencia ha vencido y el acceso al panel de administración está bloqueado hasta que se regularice el pago. La web y las ventas
              siguen funcionando con normalidad{scanner ? ', y el personal de puerta puede seguir validando entradas con el escáner' : ''}.
            </p>
          ) : (
            <>
              <p>El sitio está temporalmente fuera de servicio.</p>
              <p>Si administras este sitio, la licencia está pendiente de pago.</p>
            </>
          )}
          <p>
            <LicenseContact contact={contact} />
          </p>
          {!panelOnly && role && scanner && <p>El personal de puerta puede seguir validando entradas con el escáner.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {panelOnly && (
            <Link href="/">
              <Button size="lg" className={`gap-2 font-display font-semibold px-8 h-12 shadow-primary/25 ${pill}`}>
                Ir a la web
              </Button>
            </Link>
          )}
          {role && scanner && (
            <Link href="/acceso">
              <Button size="lg" variant={panelOnly ? 'outline' : 'default'} className={`gap-2 font-display font-semibold px-8 h-12 ${pill}`}>
                Escáner de entradas
              </Button>
            </Link>
          )}
          {role ? (
            <LicenseSignOut />
          ) : (
            !panelOnly && (
              <Link href="/auth/login">
                <Button size="lg" variant="outline" className={`gap-2 font-display font-semibold px-8 h-12 ${pill}`}>
                  Acceso del personal
                </Button>
              </Link>
            )
          )}
        </div>
      </div>
    </div>
  );
}
