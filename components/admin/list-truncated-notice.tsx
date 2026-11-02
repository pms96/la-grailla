/* H-223: una lista que la API corta en un tope sin paginar. Si llega al tope, se dice (y qué hacer): quien ve «Pendientes» o «Email fallido» no debe creer que no hay más. */
export function ListTruncatedNotice({ shown, limit, what }: { shown: number; limit: number; what: string }) {
  if (shown < limit) return null;
  return (
    <p role="status" className="rounded-lg border border-warm-yellow/50 bg-warm-yellow/10 px-3 py-2 text-sm">
      Se muestran las {limit} {what} más recientes y puede haber más. Busca o filtra para acotar, o exporta para tenerlas todas.
    </p>
  );
}
