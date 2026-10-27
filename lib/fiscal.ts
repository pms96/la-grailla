import { getConfigs } from '@/lib/config';
import { getBrand } from '@/lib/brand/brand';

/* P0-11 · Datos fiscales del emisor e IVA de los justificantes de compra.
 *
 * La plataforma NO emite facturas (ver docs/platform/marco-legal.md): lo que el comprador recibe es un «justificante de compra» que dice
 * expresamente que no es factura, con los datos del vendedor y el IVA incluido. El tipo de IVA lo fija el cliente en Configuración
 * (vacío = no configurado: el justificante no desglosa nada). Se copia al pedido al crearlo (`vatRate`), así cambiarlo después no reescribe
 * justificantes ya emitidos. Un único tipo por módulo; por producto/entrada llega con el facturador certificado (fase 2). */

export type FiscalKind = 'entradas' | 'tienda';

export const VAT_RATE_CONFIG_KEY: Record<FiscalKind, string> = { entradas: 'vat_rate_entradas', tienda: 'vat_rate_tienda' };

export const RECEIPT_TITLE = 'Justificante de compra';
export const NOT_AN_INVOICE = 'Este justificante no es una factura.';

/** Interpreta el valor de la configuración: vacío o inválido = null (no configurado); acepta coma decimal. Redondea a 2 decimales. */
export function parseVatRate(raw: string | null | undefined): number | null {
  const v = (raw ?? '').trim().replace(',', '.');
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

export type VatBreakdown = { rate: number; base: number; vat: number; total: number };

/** Desglosa un total CON IVA incluido. En céntimos enteros: base = total / (1 + tipo), cuota = total − base. Null si no hay tipo. */
export function vatBreakdown(total: number, rate: number | null | undefined): VatBreakdown | null {
  if (rate == null || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(total)) return null;
  const totalCents = Math.round(total * 100);
  const baseCents = Math.round(totalCents / (1 + rate / 100));
  return { rate, base: baseCents / 100, vat: (totalCents - baseCents) / 100, total: totalCents / 100 };
}

export type FiscalIssuer = { name: string; nif: string; address: string };

/** Los datos del vendedor que se imprimen en el justificante. Sin NIF no hay emisor identificable: null (y no se inventa nada). */
export async function getFiscalIssuer(): Promise<FiscalIssuer | null> {
  const [c, brand] = await Promise.all([getConfigs(['fiscal_legal_name', 'fiscal_nif', 'fiscal_address']), getBrand()]);
  const nif = c.fiscal_nif.trim();
  if (!nif) return null;
  return { name: c.fiscal_legal_name.trim() || brand.legalName, nif, address: c.fiscal_address.trim() };
}

/** Líneas de texto del emisor para pantallas, correos y recibos: «Razón social · NIF X», y el domicilio si lo hay. */
export function issuerLines(issuer: FiscalIssuer | null): string[] {
  if (!issuer) return [];
  const lines = [`${issuer.name} · NIF ${issuer.nif}`];
  if (issuer.address) lines.push(issuer.address);
  return lines;
}

/** Lo que las pantallas y los correos imprimen junto al total. `invoiceEmail`: dónde pedir la factura (el contacto de la marca). */
export type FiscalView = { issuer: FiscalIssuer | null; vat: VatBreakdown | null; invoiceEmail: string | null };

export async function buildFiscalView(total: number, vatRate: number | null | undefined): Promise<FiscalView> {
  const [issuer, brand] = await Promise.all([getFiscalIssuer(), getBrand()]);
  return { issuer, vat: vatBreakdown(total, vatRate), invoiceEmail: brand.contactEmail || null };
}

/** El tipo vigente ahora para el módulo (se copia al pedido al crearlo). */
export async function currentVatRate(kind: FiscalKind): Promise<number | null> {
  const key = VAT_RATE_CONFIG_KEY[kind];
  return parseVatRate((await getConfigs([key]))[key]);
}

const eur = (n: number) => n.toFixed(2).replace('.', ',') + ' €';

/** Texto plano del desglose para correos: «IVA incluido (10 %): base 18,18 € · cuota 1,82 €». */
export function vatText(vat: VatBreakdown | null): string {
  if (!vat) return 'IVA incluido';
  const rate = String(vat.rate).replace('.', ',');
  return `IVA incluido (${rate} %): base ${eur(vat.base)} · cuota ${eur(vat.vat)}`;
}
