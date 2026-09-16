'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Handshake, Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/layouts/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { CONSOLIDATED_STATUS_LABELS, CONSOLIDATED_STATUS_VARIANT, consolidatedSponsorStatus, type ConsolidatedSponsorStatus } from '@/lib/sponsor-status';
import { findSponsorTier, type SponsorTier } from '@/lib/sponsor-tiers';
import { CreateSponsorDialog } from './_components/create-sponsor-dialog';

type SponsorRow = {
  id: string;
  companyName: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  sponsorType: string | null;
  status: string;
  createdAt: string;
  sponsor: { id: string; status: string; invitationEmailStatus: string | null } | null;
};

export default function SponsorsAdminPage() {
  const [sponsors, setSponsors] = useState<SponsorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [tiers, setTiers] = useState<SponsorTier[]>([]);

  const fetchSponsors = () => {
    fetch('/api/admin/sponsors')
      .then((r) => r.json())
      .then((d) => setSponsors(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSponsors(); }, []);
  useEffect(() => {
    fetch('/api/sponsors/tiers')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.tiers)) setTiers(d.tiers); })
      .catch(() => {});
  }, []);

  const withStatus = sponsors.map((s) => ({ ...s, consolidated: consolidatedSponsorStatus(s), tier: findSponsorTier(tiers, s.sponsorType) }));
  const filtered = withStatus.filter((s) => {
    if (statusFilter !== 'all' && s.consolidated !== statusFilter) return false;
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return (
      s.companyName.toLowerCase().includes(needle) ||
      s.contactName.toLowerCase().includes(needle) ||
      (s.email ?? '').toLowerCase().includes(needle)
    );
  });

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sponsors"
        description="Del lead a la aprobación del vídeo — un único flujo por sponsor"
        actions={
          <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Añadir sponsor
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Empresa, contacto o email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {Object.entries(CONSOLIDATED_STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <Handshake className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">{sponsors.length === 0 ? 'No hay sponsors aún' : 'Nada coincide con estos filtros'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((s) => (
            <Link key={s.id} href={`/admin/sponsors/${s.id}`}>
              <Card className="hover:bg-muted/30 transition-colors cursor-pointer">
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.companyName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {s.contactName}{s.email ? ` · ${s.email}` : ' · sin email'}{s.phone ? ` · ${s.phone}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.tier ? `${s.tier.label} — ${s.tier.priceLabel}` : (s.sponsorType ?? 'Sin tipo asignado')}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <StatusBadge<ConsolidatedSponsorStatus> status={s.consolidated} labels={CONSOLIDATED_STATUS_LABELS} variants={CONSOLIDATED_STATUS_VARIANT} />
                    {s.sponsor?.invitationEmailStatus === 'FAILED' && (
                      <span className="text-xs text-destructive">⚠️ Invitación no enviada</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateSponsorDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={fetchSponsors} />
    </div>
  );
}
