'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GuestList, Invitation } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Trash2, Mail, ListPlus, Users } from 'lucide-react';
import { toast } from 'sonner';

type Props = { selectedEvent: string };

type GuestListWithInvitations = GuestList & { invitations: Invitation[] };

type InvitationWithRelations = Invitation & {
  list: { id: string; name: string } | null;
  order: { id: string; emailSentAt: string | Date | null; tickets: { id: string; status: string }[] } | null;
};

export default function InvitationsManager({ selectedEvent }: Props) {
  const [lists, setLists] = useState<GuestListWithInvitations[]>([]);
  const [invitations, setInvitations] = useState<InvitationWithRelations[]>([]);
  const [loading, setLoading] = useState(false);

  const [newListName, setNewListName] = useState('');
  const [newListOwner, setNewListOwner] = useState('');
  const [creatingList, setCreatingList] = useState(false);

  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [listId, setListId] = useState('none');
  const [notes, setNotes] = useState('');
  const [sendEmail, setSendEmail] = useState('true');
  const [creatingInv, setCreatingInv] = useState(false);

  const load = useCallback(async () => {
    if (!selectedEvent) return;
    setLoading(true);
    try {
      const [lr, ir] = await Promise.all([
        fetch('/api/guest-lists?eventId=' + selectedEvent),
        fetch('/api/invitations?eventId=' + selectedEvent),
      ]);
      setLists((await lr.json()) ?? []);
      setInvitations((await ir.json()) ?? []);
    } catch {
      toast.error('No se pudieron cargar las invitaciones');
    } finally {
      setLoading(false);
    }
  }, [selectedEvent]);

  useEffect(() => { load(); }, [load]);

  const createList = async () => {
    if (!newListName.trim()) { toast.error('Indica el nombre de la lista'); return; }
    setCreatingList(true);
    try {
      const res = await fetch('/api/guest-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: selectedEvent, name: newListName.trim(), ownerName: newListOwner.trim() }),
      });
      if (!res.ok) { toast.error('Error al crear la lista'); return; }
      setNewListName('');
      setNewListOwner('');
      toast.success('Lista creada');
      load();
    } finally {
      setCreatingList(false);
    }
  };

  const deleteList = async (id: string) => {
    if (!confirm('¿Eliminar esta lista? Se perderán sus invitaciones.')) return;
    const res = await fetch('/api/guest-lists?id=' + id, { method: 'DELETE' });
    if (res.ok) { toast.success('Lista eliminada'); load(); } else { toast.error('No se pudo eliminar'); }
  };

  const createInvitation = async () => {
    if (!guestName.trim()) { toast.error('Indica el nombre del invitado'); return; }
    setCreatingInv(true);
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEvent,
          listId: listId === 'none' ? null : listId,
          guestName: guestName.trim(),
          guestEmail: guestEmail.trim(),
          quantity: parseInt(quantity, 10) || 1,
          notes: notes.trim() || null,
          sendEmail: sendEmail === 'true' && !!guestEmail.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data?.error ?? 'Error al crear la invitación'); return; }
      setGuestName('');
      setGuestEmail('');
      setQuantity('1');
      setNotes('');
      toast.success('Invitación creada');
      load();
    } finally {
      setCreatingInv(false);
    }
  };

  const deleteInvitation = async (id: string) => {
    if (!confirm('¿Anular esta invitación? Se cancelará la entrada asociada y bajará el aforo.')) return;
    const res = await fetch('/api/invitations?id=' + id, { method: 'DELETE' });
    if (res.ok) { toast.success('Invitación anulada'); load(); } else { toast.error('No se pudo anular'); }
  };

  const resend = async (orderId: string) => {
    toast.info('Enviando entradas…');
    const res = await fetch('/api/orders/' + orderId + '/send-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    if (res.ok) { toast.success('Entradas enviadas'); load(); } else { toast.error('No se pudo enviar el email'); }
  };

  if (!selectedEvent) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Selecciona un evento para gestionar invitaciones.</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><ListPlus className="h-4 w-4 text-primary" /> Nueva lista (RRPP)</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Nombre de la lista" value={newListName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewListName(e?.target?.value ?? '')} />
            <Input placeholder="Responsable / RRPP" value={newListOwner} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewListOwner(e?.target?.value ?? '')} />
          </div>
          <Button onClick={createList} disabled={creatingList} size="sm" className="gap-2">
            {creatingList ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear lista
          </Button>

          {(lists ?? []).length > 0 && (
            <div className="space-y-2 pt-2">
              {lists.map((l) => (
                <div key={l?.id} className="flex items-center justify-between gap-2 text-sm border border-border rounded-md px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{l?.name ?? ''}</p>
                    <p className="text-xs text-muted-foreground">{l?.ownerName ?? 'Sin responsable'} · {(l?.invitations ?? []).length} invitación(es)</p>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => deleteList(l.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><Users className="h-4 w-4 text-primary" /> Nueva invitación</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Nombre del invitado *</Label><Input value={guestName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGuestName(e?.target?.value ?? '')} className="mt-1" /></div>
            <div><Label>Email</Label><Input type="email" value={guestEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGuestEmail(e?.target?.value ?? '')} className="mt-1" /></div>
            <div><Label>Entradas</Label><Input type="number" min="1" max="20" value={quantity} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuantity(e?.target?.value ?? '1')} className="mt-1" /></div>
            <div>
              <Label>Lista</Label>
              <Select value={listId} onValueChange={setListId}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin lista</SelectItem>
                  {lists.map((l) => (<SelectItem key={l?.id} value={l?.id ?? ''}>{l?.name ?? ''}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Enviar entradas por email</Label>
              <Select value={sendEmail} onValueChange={setSendEmail}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Sí</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>Notas internas</Label>
              <Input
                value={notes}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNotes(e?.target?.value ?? '')}
                className="mt-1"
                placeholder="Opcional"
              />
            </div>
          </div>
          <Button onClick={createInvitation} disabled={creatingInv} className="gap-2">
            {creatingInv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear invitación
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-2">
          <h3 className="font-semibold text-sm">Invitaciones del evento</h3>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {!loading && invitations.length === 0 && <p className="text-sm text-muted-foreground">Todavía no hay invitaciones.</p>}
          {invitations.map((inv) => (
            <div key={inv?.id} className="flex items-center justify-between gap-2 text-sm border border-border rounded-md px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{inv?.guestName ?? ''} <span className="text-muted-foreground">· {inv?.quantity ?? 1}</span></p>
                <p className="text-xs text-muted-foreground truncate">
                  {inv?.guestEmail ?? 'Sin email'}
                  {inv?.list?.name ? ' · ' + inv.list.name : ''}
                  {inv?.notes ? ' · ' + inv.notes : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {inv?.order?.emailSentAt ? <Badge variant="outline">Enviada</Badge> : null}
                {inv?.guestEmail && inv?.order?.id ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => resend(inv.order!.id)} title="Reenviar entradas"><Mail className="h-4 w-4" /></Button>
                ) : null}
                <Button variant="ghost" size="icon-sm" onClick={() => deleteInvitation(inv.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
