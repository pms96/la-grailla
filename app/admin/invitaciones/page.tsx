'use client';

import { useEffect, useState } from 'react';
import type { Event } from '@prisma/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import InvitationsManager from '@/components/admin/invitations-manager';
import {
  getStoredActiveEventId,
  pickDefaultActiveEventId,
  setStoredActiveEventId,
} from '@/lib/active-event';

export default function InvitacionesPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/events')
      .then((r) => r.json())
      .then((list: Event[]) => {
        const published = (list ?? []).filter((e) => e.status === 'PUBLISHED' || e.status === 'DRAFT');
        // Preferir publicados; si no hay, mostrar todos no cancelados
        const pool = published.length
          ? published
          : (list ?? []).filter((e) => e.status !== 'CANCELLED');
        setEvents(pool);
        const fromUrl = new URLSearchParams(window.location.search).get('eventId');
        const stored = getStoredActiveEventId();
        let initial = '';
        if (fromUrl && pool.some((e) => e.id === fromUrl)) initial = fromUrl;
        else if (stored && pool.some((e) => e.id === stored)) initial = stored;
        else {
          initial =
            pickDefaultActiveEventId(pool.filter((e) => e.status === 'PUBLISHED')) ||
            pool[0]?.id ||
            '';
        }
        if (initial) setEventId(initial);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleEventChange = (id: string) => {
    setEventId(id);
    setStoredActiveEventId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('eventId', id);
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <PageHeader
          title="Invitaciones"
          description="Listas RRPP y entradas gratuitas antes del evento"
        />
        <Select value={eventId} onValueChange={handleEventChange}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue placeholder="Selecciona evento" />
          </SelectTrigger>
          <SelectContent>
            {events.map((ev) => (
              <SelectItem key={ev.id} value={ev.id}>
                {ev.name}
                {ev.status === 'DRAFT' ? ' (borrador)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!events.length ? (
        <p className="text-center py-16 text-muted-foreground">No hay eventos disponibles</p>
      ) : (
        <InvitationsManager selectedEvent={eventId} />
      )}
    </div>
  );
}
