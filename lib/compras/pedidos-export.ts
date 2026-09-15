'use client';

import type { PedidosExportOptions } from '@/lib/compras/pedidos-data';

/** Descarga los pedidos de una temporada (uno por proveedor) en Excel o PDF, con las columnas que marquen los checks de opts. */
export async function downloadPedidosExport(
  temporadaId: string,
  format: 'excel' | 'pdf',
  opts: PedidosExportOptions = {}
): Promise<void> {
  const {
    incluirFormato = false,
    incluirFormatoProveedor = false,
    incluirPrecioSinIva = false,
    incluirPrecioConIva = false,
    incluirIvaDescuento = false,
    incluirSubtotalSinIva = false,
    incluirSubtotalConIva = false,
  } = opts;
  const qs = new URLSearchParams({
    temporadaId,
    format,
    incluirFormato: String(incluirFormato),
    incluirFormatoProveedor: String(incluirFormatoProveedor),
    incluirPrecioSinIva: String(incluirPrecioSinIva),
    incluirPrecioConIva: String(incluirPrecioConIva),
    incluirIvaDescuento: String(incluirIvaDescuento),
    incluirSubtotalSinIva: String(incluirSubtotalSinIva),
    incluirSubtotalConIva: String(incluirSubtotalConIva),
  });
  const res = await fetch(`/api/admin/compras/pedidos/export?${qs.toString()}`);
  if (!res.ok) {
    let message = 'No se pudo exportar';
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `pedidos.${format === 'excel' ? 'xlsx' : 'pdf'}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
