/* Aviso de vista previa de un borrador (H-167). Solo lo ve quien puede previsualizar borradores (ADMIN con Entradas, H-059): para todos los demás la ficha es un 404. */
export function DraftPreviewNotice() {
  return (
    <div role="note" className="border-b border-border bg-muted px-4 py-2 text-center text-sm text-foreground">
      <strong className="font-semibold">Borrador.</strong> Esta ficha solo lo ves tú, como administrador: el público recibe un 404 hasta que publiques el evento.
    </div>
  );
}
