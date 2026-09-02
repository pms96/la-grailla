'use client';

/** Descarga los pedidos de una temporada (uno por proveedor) en Excel o PDF, con o sin precios. */
export async function downloadPedidosExport(temporadaId: string, format: 'excel' | 'pdf', incluirPrecios = true): Promise<void> {
  const qs = new URLSearchParams({ temporadaId, format, incluirPrecios: String(incluirPrecios) });
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
