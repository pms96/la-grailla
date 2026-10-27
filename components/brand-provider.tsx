'use client';

import { createContext, useContext } from 'react';
import type { ModuleKey } from '@grailla/contracts';

/* Lo mínimo de la marca que necesitan los componentes de cliente (el logo, sobre todo). Lo rellena el layout raíz desde `getBrand()`;
 * el servidor sigue siendo quien decide qué marca es. Sin proveedor (tests, Storybook) cae a un valor neutro, nunca al de La Grailla. */

export type ClientBrand = {
  name: string;
  /** Dirección de contacto del cliente ('' = no la ha configurado: no se muestra ningún enlace). */
  contactEmail: string;
  /** Cómo se nombra al organizador en textos formales (autorización de menores). */
  organizer: string;
  /** Logo para superficies oscuras / claras. null = sin logo (se muestra el nombre). */
  logoOnDark: string | null;
  logoOnLight: string | null;
  /** Modo por defecto del sitio: decide qué versión del logo se precarga. */
  mode: 'dark' | 'light' | 'system';
  /** ¿El formulario de contacto está encendido? (valor efectivo, con el defecto del cliente.) */
  contactFormEnabled: boolean;
  /** Módulos activos del cliente (el servidor decide; esto solo adapta pantallas, no autoriza nada). */
  modules: readonly ModuleKey[];
  /** ¿Es La Grailla (instalación única o cliente legacy)? Solo ella conserva sus textos de siempre («caseta», «Feria»…); el resto, valores neutros. Solo adapta textos: no autoriza nada. */
  legacy: boolean;
  /** Prefijo de Blob de este cliente (`{tenantId}/` en modo plataforma, vacío en una instalación única) para las subidas directas del navegador. */
  blobPrefix: string;
};

const EMPTY: ClientBrand = { name: '', contactEmail: '', organizer: '', logoOnDark: null, logoOnLight: null, mode: 'dark', contactFormEnabled: false, modules: [], legacy: false, blobPrefix: '' };
const BrandContext = createContext<ClientBrand>(EMPTY);

export function BrandProvider({ value, children }: { value: ClientBrand; children: React.ReactNode }) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export const useBrand = (): ClientBrand => useContext(BrandContext);
