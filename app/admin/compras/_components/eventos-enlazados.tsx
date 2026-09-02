'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Event } from '@prisma/client';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { CalendarDays } from 'lucide-react';

type Props = { temporadaId: string | null };

// Vista de solo lectura del vínculo Evento↔Temporada (Fase 2 del plan de
// actuación): qué eventos de venta de entradas están enlazados a la
// temporada de compras/gastos seleccionada, con acceso directo a cada uno.
export function EventosEnlazados({ temporadaId }: Props) {
  const [eventos, setEventos] = useState<Event[]>([]);

  useEffect(() => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((d) => setEventos(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  if (!temporadaId) return null;
  const enlazados = eventos.filter((e) => e.temporadaId === temporadaId);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
        >
          <CalendarDays className="h-3.5 w-3.5" />
          {enlazados.length} evento{enlazados.length === 1 ? '' : 's'} enlazado{enlazados.length === 1 ? '' : 's'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        {enlazados.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ningún evento enlazado todavía. Enlázalos desde{' '}
            <Link href="/admin/eventos" className="underline text-primary">
              Eventos
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-2">
            {enlazados.map((ev) => (
              <li key={ev.id}>
                <Link href={`/admin/eventos#${ev.id}`} className="text-sm hover:text-primary hover:underline">
                  {ev.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
