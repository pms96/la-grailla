'use client';

/** Descarga un CSV del endpoint de export admin (abre en nueva pestaña con cookies de sesión). */
export async function downloadAdminCsv(params: {
  type: 'orders' | 'tickets';
  eventId?: string;
  status?: string;
  q?: string;
  emailFailed?: boolean;
}): Promise<void> {
  const qs = new URLSearchParams({ type: params.type });
  if (params.eventId) qs.set('eventId', params.eventId);
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  if (params.emailFailed) qs.set('emailFailed', '1');
  await downloadCsv(`/api/admin/export?${qs.toString()}`, `export-${params.type}.csv`);
}

/** Descarga el CSV de pedidos de tienda con los mismos filtros que el listado (búsqueda y estado). */
export async function downloadShopOrdersCsv(params: { status?: string; q?: string }): Promise<void> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  await downloadCsv(`/api/admin/shop-orders/export?${qs.toString()}`, 'pedidos-tienda.csv');
}

async function downloadCsv(endpoint: string, fallbackName: string): Promise<void> {
  const res = await fetch(endpoint);
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
  const filename = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
