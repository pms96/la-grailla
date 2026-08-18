'use client';

import { useEffect, useState } from 'react';
import type { SponsorRequest, SponsorRequestStatus } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';

const statusLabels: Record<string, string> = {
  PENDING: 'Pendiente', CONTACTED: 'Contactado', ACCEPTED: 'Aceptado', REJECTED: 'Rechazado',
};

export default function SponsorsAdminPage() {
  const [sponsors, setSponsors] = useState<SponsorRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSponsors = () => {
    fetch('/api/admin/sponsors')
      .then((r) => r.json())
      .then((d) => setSponsors(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSponsors(); }, []);

  const updateSponsor = async (id: string, data: Partial<Pick<SponsorRequest, 'status'>>) => {
    try {
      await fetch(`/api/admin/sponsors/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      toast.success('Actualizado');
      fetchSponsors();
    } catch { toast.error('Error'); }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Solicitudes de Patrocinio" description="Gestiona las solicitudes de sponsors" />

      {(sponsors?.length ?? 0) === 0 ? (
        <div className="text-center py-20">
          <Handshake className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No hay solicitudes aún</p>
        </div>
      ) : (
        <div className="space-y-4">
          {sponsors.map((s) => (
            <Card key={s?.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{s?.companyName ?? ''}</p>
                    <p className="text-xs text-muted-foreground">{s?.contactName ?? ''} · {s?.email ?? ''} · {s?.phone ?? ''}</p>
                  </div>
                  <Badge>{statusLabels[s?.status ?? ''] ?? s?.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground"><strong>Tipo:</strong> {s?.sponsorType ?? ''}</p>
                {s?.message && <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded">{s.message}</p>}
                <div className="flex items-center gap-2">
                  <Select value={s?.status ?? 'PENDING'} onValueChange={(v: SponsorRequestStatus) => updateSponsor(s?.id, { status: v })}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(statusLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
