'use client';

/** Descarga el catálogo de artículos (con precios por proveedor) en Excel o PDF. */
export async function downloadArticulosExport(format: 'excel' | 'pdf'): Promise<void> {
  const res = await fetch(`/api/admin/compras/articulos/export?format=${format}`);
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
  const filename = match?.[1] ?? `articulos.${format === 'excel' ? 'xlsx' : 'pdf'}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
