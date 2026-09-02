'use client';

import { useEffect, useState } from 'react';
import type { Event, EventStatus, Temporada } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Plus, Pencil, Trash2, Loader2, Calendar, Hourglass, ShoppingCart, Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import { ConfirmDeleteDialog } from '@/app/admin/_components/confirm-delete-dialog';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { hasEventEnded } from '@/lib/active-event';

type EventWithCount = Event & { _count?: { tickets: number }; temporada?: { id: string; nombre: string } | null };

type EventFormState = {
  name: string;
  description: string;
  venue: string;
  city: string;
  address: string;
  artists: string;
  date: string;
  doorsOpen: string;
  endTime: string;
  minAge: number;
  conditions: string;
  maxCapacity: number;
  maxTicketsPerEmail: number | string;
  waitingRoomEnabled: boolean;
  waitingRoomConcurrentSlots: number | string;
  waitingRoomPurchaseWindowMinutes: number | string;
  waitingRoomMessage: string;
  status: EventStatus;
  latitude: number | string;
  longitude: number | string;
  imageUrl: string;
  temporadaId: string | null;
};

const DEFAULT_WAITING_ROOM_SLOTS = 20;
const DEFAULT_WAITING_ROOM_WINDOW_MINUTES = 5;

export default function EventsManager() {
  const [events, setEvents] = useState<EventWithCount[]>([]);
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [verArchivados, setVerArchivados] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventWithCount | null>(null);
  const [form, setForm] = useState<Partial<EventFormState>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EventWithCount | null>(null);

  const fetchEvents = (verArchivadosParam?: boolean) => {
    const params = (verArchivadosParam ?? verArchivados) ? '?incluirArchivados=1' : '';
    fetch(`/api/admin/events${params}`)
      .then((r) => r.json())
      .then((d) => setEvents(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchEvents();
    fetch('/api/admin/compras/temporadas')
      .then((r) => r.json())
      .then((d) => setTemporadas(Array.isArray(d) ? d : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setEditingEvent(null);
    setForm({ name: '', description: '', venue: '', city: '', address: '', artists: '', date: '', doorsOpen: '', endTime: '', minAge: 18, conditions: '', maxCapacity: 500, maxTicketsPerEmail: '', waitingRoomEnabled: false, waitingRoomConcurrentSlots: '', waitingRoomPurchaseWindowMinutes: '', waitingRoomMessage: '', status: 'DRAFT', latitude: '', longitude: '', imageUrl: '', temporadaId: null });
    setDialogOpen(true);
  };

  const openEdit = (event: EventWithCount) => {
    setEditingEvent(event);
    setForm({
      name: event?.name ?? '',
      description: event?.description ?? '',
      venue: event?.venue ?? '',
      city: event?.city ?? '',
      address: event?.address ?? '',
      artists: event?.artists ?? '',
      date: event?.date ? new Date(event.date).toISOString().slice(0, 16) : '',
      doorsOpen: event?.doorsOpen ?? '',
      endTime: event?.endTime ?? '',
      minAge: event?.minAge ?? 18,
      conditions: event?.conditions ?? '',
      maxCapacity: event?.maxCapacity ?? 500,
      maxTicketsPerEmail: event?.maxTicketsPerEmail ?? '',
      waitingRoomEnabled: event?.waitingRoomEnabled ?? false,
      waitingRoomConcurrentSlots: event?.waitingRoomConcurrentSlots ?? '',
      waitingRoomPurchaseWindowMinutes: event?.waitingRoomPurchaseWindowSeconds ? event.waitingRoomPurchaseWindowSeconds / 60 : '',
      waitingRoomMessage: event?.waitingRoomMessage ?? '',
      status: event?.status ?? 'DRAFT',
      latitude: event?.latitude ?? '',
      longitude: event?.longitude ?? '',
      imageUrl: event?.imageUrl ?? '',
      temporadaId: event?.temporadaId ?? null,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editingEvent ? `/api/admin/events/${editingEvent.id}` : '/api/admin/events';
      const method = editingEvent ? 'PUT' : 'POST';
      const { waitingRoomPurchaseWindowMinutes, ...rest } = form;
      const payload = {
        ...rest,
        waitingRoomPurchaseWindowSeconds:
          waitingRoomPurchaseWindowMinutes === '' || waitingRoomPurchaseWindowMinutes == null
            ? ''
            : Number(waitingRoomPurchaseWindowMinutes) * 60,
      };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data?.error) {
        toast.error(data.error);
      } else {
        toast.success(editingEvent ? 'Evento actualizado' : 'Evento creado');
        setDialogOpen(false);
        fetchEvents();
      }
    } catch {
      toast.error('Error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await fetch(`/api/admin/events/${deleteTarget.id}`, { method: 'DELETE' });
      toast.success('Evento eliminado');
      fetchEvents();
    } catch {
      toast.error('Error al eliminar');
    } finally {
      setDeleteTarget(null);
    }
  };

  // Archivar es reversible y de bajo riesgo (Fase 4) — deshacer con un toast
  // en vez de pedir confirmación con un confirm().
  const setArchivado = async (id: string, archivado: boolean) => {
    const res = await fetch(`/api/admin/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivado }),
    });
    if (!res.ok) { toast.error('No se pudo actualizar el evento'); return; }
    fetchEvents();
  };

  const handleArchive = (event: EventWithCount) => {
    setArchivado(event.id, true);
    toast.success(`"${event.name}" archivado`, {
      duration: 5000,
      action: { label: 'Deshacer', onClick: () => setArchivado(event.id, false) },
    });
  };

  const handleRestore = (event: EventWithCount) => {
    setArchivado(event.id, false);
    toast.success(`"${event.name}" restaurado`);
  };

  const updateField = <K extends keyof EventFormState>(key: K, value: EventFormState[K]) =>
    setForm((prev) => ({ ...(prev ?? {}), [key]: value }));

  const handleChange = (key: keyof EventFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    updateField(key, e?.target?.value ?? '');

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="Eventos" description="Gestiona todos los eventos" />
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={verArchivados}
              onCheckedChange={(v: boolean) => { setVerArchivados(v); fetchEvents(v); }}
              className="scale-75 -mr-1"
            />
            Ver archivados
          </label>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" /> Nuevo Evento</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editingEvent ? 'Editar Evento' : 'Nuevo Evento'}</DialogTitle></DialogHeader>
            <div className="space-y-4 mt-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div><Label>Nombre</Label><Input value={form?.name ?? ''} onChange={handleChange('name')} className="mt-1" /></div>
                <div><Label>Estado</Label>
                  <Select value={form?.status ?? 'DRAFT'} onValueChange={(v: EventStatus) => updateField('status', v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Borrador</SelectItem>
                      <SelectItem value="PUBLISHED">Publicado</SelectItem>
                      <SelectItem value="FINISHED">Finalizado</SelectItem>
                      <SelectItem value="CANCELLED">Cancelado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label>Descripción</Label><Textarea value={form?.description ?? ''} onChange={handleChange('description')} className="mt-1" rows={3} /></div>
              <div>
                <Label>Imagen principal</Label>
                <ImageUploadField
                  value={form?.imageUrl ?? ''}
                  onChange={(url) => updateField('imageUrl', url)}
                  prefix="events"
                  className="mt-1"
                />
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                <div><Label>Sala/Recinto</Label><Input value={form?.venue ?? ''} onChange={handleChange('venue')} className="mt-1" /></div>
                <div><Label>Ciudad</Label><Input value={form?.city ?? ''} onChange={handleChange('city')} className="mt-1" /></div>
                <div><Label>Aforo máximo</Label><Input type="number" value={form?.maxCapacity ?? 500} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateField('maxCapacity', parseInt(e?.target?.value) || 500)} className="mt-1" /></div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4 text-primary" />
                  <Label>Temporada de compras (opcional)</Label>
                </div>
                <TemporadaSelector
                  temporadas={temporadas}
                  temporadaId={form?.temporadaId ?? null}
                  onChange={(id) => updateField('temporadaId', id)}
                  onTemporadaCreada={(t) => setTemporadas((prev) => [t, ...prev])}
                  allowNone
                />
                <p className="text-xs text-muted-foreground">
                  Vincula este evento a la temporada de Compras/Gastos de la caseta, para poder calcular el resultado económico real más adelante.
                </p>
              </div>
              <div>
                <Label>Máx. entradas por email (opcional)</Label>
                <Input type="number" min={1} value={form?.maxTicketsPerEmail ?? ''} onChange={handleChange('maxTicketsPerEmail')} className="mt-1" placeholder="Sin límite" />
                <p className="text-xs text-muted-foreground mt-1">Límite de entradas que un mismo email puede comprar para este evento. Déjalo vacío para no limitar.</p>
              </div>

              <div className="space-y-4 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Hourglass className="h-4 w-4 text-primary" />
                    <Label className="font-semibold">Sala de espera virtual</Label>
                  </div>
                  <Switch checked={form?.waitingRoomEnabled ?? false} onCheckedChange={(v: boolean) => updateField('waitingRoomEnabled', v)} />
                </div>
                <p className="text-xs text-muted-foreground -mt-2">
                  Ordena la entrada al checkout cuando se espera mucha demanda: solo deja pasar a N compradores a la vez, el resto espera su turno de forma visible.
                </p>
                {form?.waitingRoomEnabled && (
                  <div className="space-y-4 pt-2 border-t border-border">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <Label>Compradores simultáneos en el checkout</Label>
                        <Input
                          type="number"
                          min={1}
                          value={form?.waitingRoomConcurrentSlots ?? ''}
                          onChange={handleChange('waitingRoomConcurrentSlots')}
                          className="mt-1"
                          placeholder={String(DEFAULT_WAITING_ROOM_SLOTS)}
                        />
                      </div>
                      <div>
                        <Label>Tiempo para completar la compra (minutos)</Label>
                        <Input
                          type="number"
                          min={1}
                          value={form?.waitingRoomPurchaseWindowMinutes ?? ''}
                          onChange={handleChange('waitingRoomPurchaseWindowMinutes')}
                          className="mt-1"
                          placeholder={String(DEFAULT_WAITING_ROOM_WINDOW_MINUTES)}
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Mensaje personalizado (opcional)</Label>
                      <Textarea
                        value={form?.waitingRoomMessage ?? ''}
                        onChange={handleChange('waitingRoomMessage')}
                        className="mt-1"
                        rows={2}
                        placeholder="Ej: Sabemos que hay mucha demanda para este evento — tu turno está asegurado."
                      />
                    </div>
                  </div>
                )}
              </div>

              <div><Label>Dirección</Label><Input value={form?.address ?? ''} onChange={handleChange('address')} className="mt-1" /></div>
              <div className="grid md:grid-cols-2 gap-4">
                <div><Label>Latitud (opcional)</Label><Input value={form?.latitude ?? ''} onChange={handleChange('latitude')} className="mt-1" placeholder="40.4168" /></div>
                <div><Label>Longitud (opcional)</Label><Input value={form?.longitude ?? ''} onChange={handleChange('longitude')} className="mt-1" placeholder="-3.7038" /></div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">Si dejas las coordenadas vacías, el mapa de la página del evento usará la dirección y la ciudad.</p>
              <div><Label>Artistas (separados por coma)</Label><Input value={form?.artists ?? ''} onChange={handleChange('artists')} className="mt-1" /></div>
              <div className="grid md:grid-cols-3 gap-4">
                <div><Label>Fecha y hora</Label><Input type="datetime-local" value={form?.date ?? ''} onChange={handleChange('date')} className="mt-1" /></div>
                <div><Label>Apertura puertas</Label><Input value={form?.doorsOpen ?? ''} onChange={handleChange('doorsOpen')} className="mt-1" placeholder="23:00" /></div>
                <div><Label>Fin</Label><Input value={form?.endTime ?? ''} onChange={handleChange('endTime')} className="mt-1" placeholder="06:00" /></div>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div><Label>Edad mínima</Label><Input type="number" value={form?.minAge ?? 18} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateField('minAge', parseInt(e?.target?.value) || 18)} className="mt-1" /></div>
              </div>
              <div><Label>Condiciones de acceso</Label><Textarea value={form?.conditions ?? ''} onChange={handleChange('conditions')} className="mt-1" rows={2} /></div>
              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {editingEvent ? 'Guardar Cambios' : 'Crear Evento'}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="space-y-3">
        {(events ?? []).map((event) => {
          const dateStr = event?.date ? new Date(event.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          return (
            <Card key={event?.id} id={event?.id} className={event?.archivado ? 'opacity-60' : undefined}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-2 rounded-lg bg-primary/10"><Calendar className="h-5 w-5 text-primary" /></div>
                  <div>
                    <p className="font-medium">{event?.name ?? ''}</p>
                    <p className="text-xs text-muted-foreground">{dateStr} · {event?.venue ?? ''}, {event?.city ?? ''} · {event?._count?.tickets ?? 0} entradas</p>
                    {event?.temporada && (
                      <p className="text-xs text-primary/80 flex items-center gap-1 mt-0.5">
                        <ShoppingCart className="h-3 w-3" /> {event.temporada.nombre}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {event?.archivado && (
                    <Badge variant="outline" className="text-xs gap-1"><Archive className="h-3 w-3" /> Archivado</Badge>
                  )}
                  <Badge variant={event?.status === 'PUBLISHED' ? 'default' : event?.status === 'DRAFT' ? 'secondary' : 'outline'} className="text-xs">
                    {event?.status === 'PUBLISHED' ? 'Publicado' : event?.status === 'DRAFT' ? 'Borrador' : event?.status === 'FINISHED' ? 'Finalizado' : 'Cancelado'}
                  </Badge>
                  {event?.status === 'PUBLISHED' && hasEventEnded(event?.date) && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Ya ha pasado — no se vende
                    </Badge>
                  )}
                  {event?.archivado ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => handleRestore(event)} title="Restaurar">
                      <ArchiveRestore className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button variant="ghost" size="icon-sm" onClick={() => handleArchive(event)} title="Archivar">
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(event)}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(event)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="Eliminar evento"
        description={deleteTarget ? `Se eliminará "${deleteTarget.name}" y todo lo asociado (entradas, pedidos, escaneos). Esta acción no se puede deshacer.` : ''}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
