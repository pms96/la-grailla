'use client';

/** Descarga el planificador de compras en Excel o PDF desde el endpoint de export admin. */
export async function downloadPlanificadorExport(temporadaId: string, format: 'excel' | 'pdf'): Promise<void> {
  const qs = new URLSearchParams({ temporadaId, format });
  const res = await fetch(`/api/admin/compras/planificador/export?${qs.toString()}`);
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
  const filename = match?.[1] ?? `planificador.${format === 'excel' ? 'xlsx' : 'pdf'}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
