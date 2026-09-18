'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Temporada } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Loader2, Sparkles, Check, X as XIcon, Mail, ExternalLink, ArrowLeft, Search, Handshake, Upload, Trash2, Film, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { upload } from '@vercel/blob/client';
import { PageHeader } from '@/components/layouts/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { TemporadaSelector } from '@/app/admin/compras/_components/temporada-selector';
import { SPONSOR_GUIDED_QUESTIONS } from '@/lib/sponsor-guided-questions';
import { CONSOLIDATED_STATUS_LABELS, CONSOLIDATED_STATUS_VARIANT, consolidatedSponsorStatus, type ConsolidatedSponsorStatus } from '@/lib/sponsor-status';
import { SponsorInviteDelivery } from '../_components/sponsor-invite-delivery';
import { SponsorAssetList } from '@/components/sponsor-asset-list';
import { parseJsonSafe } from '@/lib/utils';
import { findSponsorTier, type SponsorTier } from '@/lib/sponsor-tiers';

const LEAD_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente', CONTACTED: 'Contactado', ACCEPTED: 'Aceptado', REJECTED: 'Rechazado',
};

const EMAIL_TYPE_LABELS: Record<string, string> = {
  LEAD_CONFIRMATION: 'Confirmación de solicitud',
  PORTAL_INVITE: 'Invitación al portal',
  PORTAL_INVITE_RESEND: 'Reenvío de invitación',
  STATUS_NOTIFY: 'Aviso de estado',
  REJECTION: 'Aviso de rechazo',
};

type SponsorAsset = { id: string; url: string; fileType: string; fileName: string; uploadedAt: string };
type SponsorVideoPrompt = { promptEs: string; promptEn: string; approvedAt: string | null; notifiedAt: string | null };
type PromptGenerationLog = { id: string; attemptNumber: number; success: boolean; errorMessage: string | null; createdAt: string };
type SponsorEmailLog = { id: string; type: string; recipient: string; success: boolean; error: string | null; createdAt: string };

type SponsorPortal = {
  id: string;
  status: string;
  guidedAnswers: Record<string, string> | null;
  freeText: string | null;
  brandContext: string | null;
  currentAsset: SponsorAsset | null;
  assets: SponsorAsset[];
  videoPrompt: SponsorVideoPrompt | null;
  generationLogs: PromptGenerationLog[];
  generationCount: number;
  maxGenerations: number;
  isGenerating: boolean;
  invitationEmailStatus: string | null;
  finalVideoUrl: string | null;
  finalVideoFileName: string | null;
  finalVideoSize: number | null;
  finalVideoUploadedAt: string | null;
  isPaid: boolean;
  paidAmount: number | null;
  paidAt: string | null;
};

type Detail = {
  id: string;
  companyName: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  sponsorType: string | null;
  message: string | null;
  status: string;
  adminNotes: string | null;
  temporadaId: string | null;
  temporada: { id: string; nombre: string } | null;
  emailLogs: SponsorEmailLog[];
  sponsor: SponsorPortal | null;
  portalUrl: string | null;
};

export default function SponsorDetailPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [temporadas, setTemporadas] = useState<Temporada[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState({ promptEs: '', promptEn: '' });
  const [brandContextDraft, setBrandContextDraft] = useState('');
  const [uploadingFinalVideo, setUploadingFinalVideo] = useState(false);
  const [tiers, setTiers] = useState<SponsorTier[]>([]);
  const finalVideoInputRef = useRef<HTMLInputElement>(null);

  const fetchDetail = () => {
    fetch(`/api/admin/sponsors/${params.id}`)
      .then((r) => r.json())
      .then((d: Detail) => {
        setDetail(d);
        setPromptDraft({ promptEs: d?.sponsor?.videoPrompt?.promptEs ?? '', promptEn: d?.sponsor?.videoPrompt?.promptEn ?? '' });
        setBrandContextDraft(d?.sponsor?.brandContext ?? '');
      })
      .catch(() => toast.error('No se pudo cargar el sponsor'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    fetch('/api/sponsors/tiers')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.tiers)) setTiers(d.tiers); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/admin/compras/temporadas')
      .then((r) => r.json())
      .then((d) => setTemporadas(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  const updateLead = async (data: Record<string, unknown>, opts?: { silent?: boolean }) => {
    try {
      const res = await fetch(`/api/admin/sponsors/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error();
      if (!opts?.silent) toast.success('Actualizado');
      fetchDetail();
    } catch {
      toast.error('No se pudo actualizar');
    }
  };

  const saveNotes = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    const value = e?.target?.value ?? '';
    if (value === (detail?.adminNotes ?? '')) return;
    updateLead({ adminNotes: value }, { silent: true });
  };

  const acceptLead = async () => {
    setBusy('accept');
    try {
      const res = await fetch(`/api/admin/sponsors/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACCEPTED' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();
      toast.success(data?.invitationEmailSuccess === false ? 'Aceptado — pero la invitación por email falló, usa copiar enlace o WhatsApp' : 'Aceptado — invitación enviada');
      fetchDetail();
    } catch {
      toast.error('No se pudo aceptar');
    } finally {
      setBusy(null);
    }
  };

  const sponsorAction = async (action: string, method: 'POST' | 'PUT', body?: unknown) => {
    if (!detail?.sponsor) return null;
    setBusy(action);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${detail.sponsor.id}/${action}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error ?? 'Error');
      return data;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const markReady = async () => { if (await sponsorAction('ready', 'POST')) { toast.success('Marcado como listo para generar'); fetchDetail(); } };
  const generate = async () => { const r = await sponsorAction('generate', 'POST'); if (r?.success) { toast.success('Prompt generado'); fetchDetail(); } else fetchDetail(); };
  const approveWithVideo = async () => { if (await sponsorAction('approve-with-video', 'POST')) { toast.success('Aprobado con el vídeo del sponsor'); fetchDetail(); } };
  const markPaid = async () => { if (await sponsorAction('mark-paid', 'POST', { paid: true })) { toast.success('Marcado como pagado'); fetchDetail(); } };
  const unmarkPaid = async () => { if (await sponsorAction('mark-paid', 'POST', { paid: false })) { toast.success('Marca de pago retirada'); fetchDetail(); } };
  const saveBrandContext = async () => { if (await sponsorAction('brand-context', 'PUT', { brandContext: brandContextDraft })) toast.success('Contexto de marca guardado'); };
  const savePrompt = async () => { if (await sponsorAction('prompt', 'PUT', promptDraft)) toast.success('Prompt guardado'); };
  const approve = async () => { if (await sponsorAction('approve', 'POST')) { toast.success('Aprobado para vídeo'); fetchDetail(); } };
  const reject = async () => {
    const r = await sponsorAction('reject', 'POST');
    if (r) {
      toast.success(
        r.rejectionEmailSuccess
          ? 'Rechazado — sponsor avisado por email'
          : detail?.email
            ? 'Rechazado — el aviso por email falló'
            : 'Rechazado — sin email guardado, avísale por otra vía'
      );
      fetchDetail();
    }
  };
  const notify = async () => {
    const r = await sponsorAction('notify', 'POST');
    if (r?.success) { toast.success('Sponsor notificado por email'); fetchDetail(); }
    else if (r) toast.error(detail?.email ? 'No se pudo enviar el email' : 'Este sponsor no tiene email guardado');
  };
  const resendInvite = async () => { const r = await sponsorAction('resend-invite', 'POST'); if (r?.success) { toast.success('Invitación reenviada'); fetchDetail(); } else if (r) toast.error('No se pudo reenviar'); };
  const regenerateToken = async () => { const r = await sponsorAction('regenerate-token', 'POST'); if (r) { toast.success('Enlace regenerado — el anterior ha dejado de funcionar'); fetchDetail(); } };

  const uploadFinalVideo = async (file: File) => {
    if (!detail?.sponsor) return;
    setUploadingFinalVideo(true);
    try {
      // Sube directamente del navegador a Vercel Blob — el binario nunca
      // pasa por nuestro servidor, así que no choca con el límite de
      // payload (~4.5MB) de las funciones serverless de Vercel.
      const blob = await upload(`sponsors/${detail.sponsor.id}/final-video/${crypto.randomUUID()}-${file.name}`, file, {
        access: 'public',
        handleUploadUrl: `/api/admin/sponsors-portal/${detail.sponsor.id}/final-video/upload-token`,
      });

      const res = await fetch(`/api/admin/sponsors-portal/${detail.sponsor.id}/final-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: blob.url, fileName: file.name, fileSize: file.size }),
      });
      const data = await parseJsonSafe(res);
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo subir el vídeo');
      toast.success('Vídeo final subido');
      fetchDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo subir el vídeo');
    } finally {
      setUploadingFinalVideo(false);
    }
  };

  const deleteFinalVideo = async () => {
    if (!detail?.sponsor) return;
    setBusy('delete-final-video');
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${detail.sponsor.id}/final-video`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('Vídeo final eliminado');
      fetchDetail();
    } catch {
      toast.error('No se pudo eliminar el vídeo');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  if (!detail) {
    return (
      <div className="text-center py-20">
        <Handshake className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">Sponsor no encontrado</p>
        <Link href="/admin/sponsors" className="text-sm underline mt-2 inline-block">Volver a Sponsors</Link>
      </div>
    );
  }

  const sponsorTierForPayment = findSponsorTier(tiers, detail.sponsorType);

  const consolidated = consolidatedSponsorStatus(detail);
  const sponsor = detail.sponsor;
  const busyGlobal = busy !== null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/sponsors" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Sponsors
        </Link>
        <PageHeader
          title={detail.companyName}
          description={`${detail.contactName}${detail.email ? ` · ${detail.email}` : ' · sin email'}${detail.phone ? ` · ${detail.phone}` : ''}`}
          actions={<StatusBadge<ConsolidatedSponsorStatus> status={consolidated} labels={CONSOLIDATED_STATUS_LABELS} variants={CONSOLIDATED_STATUS_VARIANT} />}
        />
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground shrink-0"><strong>Tipo:</strong></label>
            <Select value={detail.sponsorType ?? ''} onValueChange={(v) => updateLead({ sponsorType: v })}>
              <SelectTrigger className="h-8 w-auto min-w-[220px]"><SelectValue placeholder="Sin asignar todavía" /></SelectTrigger>
              <SelectContent>
                {tiers.map((tier) => (
                  <SelectItem key={tier.value} value={tier.value}>{tier.label} — {tier.priceLabel}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {detail.website && (
            <p className="text-sm text-muted-foreground">
              <strong>Web:</strong> <a href={detail.website} target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-1">{detail.website} <ExternalLink className="h-3 w-3" /></a>
            </p>
          )}
          {detail.message && <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded">{detail.message}</p>}

          <div className="flex flex-wrap items-center gap-2">
            {!sponsor && (
              <Select value={detail.status} onValueChange={(v) => updateLead({ status: v })}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(LEAD_STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {!sponsor && detail.status === 'CONTACTED' && (
              <Button size="sm" disabled={busyGlobal} onClick={acceptLead} className="gap-2">
                {busy === 'accept' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Aceptar y crear portal
              </Button>
            )}
            <TemporadaSelector
              temporadas={temporadas}
              temporadaId={detail.temporadaId}
              onChange={(id) => updateLead({ temporadaId: id })}
              onTemporadaCreada={(t) => setTemporadas((prev) => [t, ...prev])}
              allowNone
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Notas internas</label>
            <Textarea defaultValue={detail.adminNotes ?? ''} onBlur={saveNotes} placeholder="Notas visibles solo para el equipo (no se envían al sponsor)" className="text-sm" rows={2} />
          </div>
        </CardContent>
      </Card>

      {sponsor && detail.portalUrl && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium">Acceso al portal</p>
            <SponsorInviteDelivery
              portalUrl={detail.portalUrl}
              contactName={detail.contactName}
              phone={detail.phone}
              hasEmail={Boolean(detail.email)}
              emailStatus={sponsor.invitationEmailStatus as 'SENT' | 'FAILED' | null}
              onResend={resendInvite}
              onRegenerate={regenerateToken}
              resending={busy === 'resend-invite'}
              regenerating={busy === 'regenerate-token'}
            />
          </CardContent>
        </Card>
      )}

      {sponsor && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Portal del sponsor</p>
              <span className="text-xs text-muted-foreground">{sponsor.generationCount}/{sponsor.maxGenerations} intentos de generación</span>
            </div>

            {sponsor.freeText && <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded">{sponsor.freeText}</p>}
            {sponsor.guidedAnswers && Object.keys(sponsor.guidedAnswers).length > 0 && (
              <div className="text-sm grid grid-cols-2 gap-2">
                {Object.entries(sponsor.guidedAnswers).map(([k, v]) => (
                  <div key={k}><span className="text-muted-foreground">{SPONSOR_GUIDED_QUESTIONS.find((q) => q.key === k)?.label ?? k}:</span> {v}</div>
                ))}
              </div>
            )}
            <SponsorAssetList assets={sponsor.assets ?? []} />

            <div className={`rounded-lg border p-3 flex items-center justify-between gap-3 flex-wrap ${sponsor.isPaid ? 'border-lima/40 bg-lima/5' : 'border-border'}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <Wallet className={`h-4 w-4 shrink-0 ${sponsor.isPaid ? 'text-lima' : 'text-muted-foreground'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{sponsor.isPaid ? 'Pagado' : 'Pago pendiente'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {sponsor.isPaid
                      ? `${(sponsor.paidAmount ?? 0).toFixed(2)}€ · ${sponsor.paidAt ? new Date(sponsor.paidAt).toLocaleDateString('es-ES') : ''}`
                      : sponsorTierForPayment
                        ? `Importe según su tipo: ${sponsorTierForPayment.priceLabel}`
                        : 'Asigna el tipo de patrocinio para poder marcarlo como pagado'}
                  </p>
                </div>
              </div>
              {sponsor.isPaid ? (
                <Button size="sm" variant="outline" disabled={busyGlobal} onClick={unmarkPaid}>
                  {busy === 'mark-paid' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Desmarcar pago'}
                </Button>
              ) : (
                <Button size="sm" disabled={busyGlobal || !sponsorTierForPayment} onClick={markPaid} className="gap-2">
                  {busy === 'mark-paid' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Marcar como pagado
                </Button>
              )}
            </div>

            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium flex items-center gap-2"><Search className="h-3.5 w-3.5" /> Contexto de marca (investigación)</p>
              </div>
              <Textarea
                rows={3}
                value={brandContextDraft}
                onChange={(e) => setBrandContextDraft(e.target.value)}
                placeholder="Ej. Vende barcos cebadores de radiocontrol para carpfishing, baterías Li-Po y accesorios electrónicos de pesca técnica."
              />
              <Button size="sm" variant="outline" disabled={busyGlobal} onClick={saveBrandContext}>Guardar contexto</Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {sponsor.status === 'PENDIENTE_REVISION' && (
                <Button size="sm" disabled={busyGlobal} onClick={markReady}>Marcar listo para generar</Button>
              )}
              {(sponsor.status === 'LISTO_PARA_GENERAR' || sponsor.status === 'PROMPT_GENERADO') && (
                sponsor.currentAsset || sponsor.status === 'PROMPT_GENERADO' ? (
                  <Button size="sm" disabled={busyGlobal || sponsor.isGenerating || sponsor.generationCount >= sponsor.maxGenerations} onClick={generate} className="gap-2">
                    {busy === 'generate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Generar con Abacus.AI
                  </Button>
                ) : (sponsor.assets ?? []).some((a) => a.fileType.startsWith('video/')) ? (
                  // Sin ninguna imagen de logo, Abacus.AI no tiene nada que animar
                  // (ver generate/route.ts) — si en cambio dieron un vídeo de
                  // referencia, se usa directamente como vídeo final.
                  <Button size="sm" variant="outline" disabled={busyGlobal} onClick={approveWithVideo} className="gap-2">
                    {busy === 'approve-with-video' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Aprobar directamente con el vídeo del sponsor
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground self-center">Este sponsor todavía no ha subido ningún logo ni vídeo.</p>
                )
              )}
              {sponsor.videoPrompt && sponsor.status !== 'APROBADO_PARA_VIDEO' && sponsor.status !== 'RECHAZADO' && (
                <Button size="sm" variant="outline" disabled={busyGlobal} onClick={approve} className="gap-2">
                  {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Aprobar para vídeo
                </Button>
              )}
              {sponsor.status !== 'RECHAZADO' && (
                <Button size="sm" variant="outline" disabled={busyGlobal} onClick={reject} className="gap-2">
                  {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XIcon className="h-3.5 w-3.5" />} Rechazar
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busyGlobal} onClick={notify} className="gap-2">
                {busy === 'notify' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Notificar por email
              </Button>
            </div>

            {sponsor.videoPrompt && (
              <Tabs defaultValue="es">
                <TabsList>
                  <TabsTrigger value="es">Español</TabsTrigger>
                  <TabsTrigger value="en">English</TabsTrigger>
                </TabsList>
                <TabsContent value="es">
                  <Textarea rows={6} value={promptDraft.promptEs} onChange={(e) => setPromptDraft((p) => ({ ...p, promptEs: e.target.value }))} />
                </TabsContent>
                <TabsContent value="en">
                  <Textarea rows={6} value={promptDraft.promptEn} onChange={(e) => setPromptDraft((p) => ({ ...p, promptEn: e.target.value }))} />
                </TabsContent>
                <Button size="sm" variant="outline" className="mt-2" disabled={busyGlobal} onClick={savePrompt}>Guardar cambios</Button>
              </Tabs>
            )}

            {sponsor.generationLogs?.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium">Historial de intentos</p>
                {sponsor.generationLogs.map((log) => (
                  <p key={log.id}>#{log.attemptNumber} — {new Date(log.createdAt).toLocaleString('es-ES')} — {log.success ? 'éxito' : `error: ${log.errorMessage}`}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {sponsor && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium flex items-center gap-2"><Film className="h-3.5 w-3.5" /> Vídeo final</p>
            </div>
            <p className="text-xs text-muted-foreground">
              El vídeo ya producido — el sponsor lo verá en su portal en cuanto esté en estado &quot;Aprobado para vídeo&quot;.
            </p>

            {sponsor.finalVideoUrl && (
              <div className="space-y-2">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video src={sponsor.finalVideoUrl} controls className="w-full max-w-md rounded-lg bg-black" />
                <p className="text-xs text-muted-foreground">{sponsor.finalVideoFileName}</p>
              </div>
            )}

            <input
              ref={finalVideoInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska,video/3gpp,video/x-m4v,video/mpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFinalVideo(file);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={uploadingFinalVideo} onClick={() => finalVideoInputRef.current?.click()} className="gap-2">
                {uploadingFinalVideo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {sponsor.finalVideoUrl ? 'Reemplazar vídeo' : 'Subir vídeo final'}
              </Button>
              {sponsor.finalVideoUrl && (
                <Button size="sm" variant="ghost" disabled={busyGlobal} onClick={deleteFinalVideo} className="gap-2 text-muted-foreground">
                  {busy === 'delete-final-video' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Eliminar
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {detail.emailLogs?.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <p className="text-sm font-medium">Historial de comunicaciones</p>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {detail.emailLogs.map((log) => (
                <div key={log.id} className="text-xs flex items-center justify-between gap-2 border-b border-border/50 pb-1.5">
                  <span className="truncate">
                    {EMAIL_TYPE_LABELS[log.type] ?? log.type} · {log.recipient}
                    {' · '}{new Date(log.createdAt).toLocaleString('es-ES')}
                  </span>
                  <span className={log.success ? 'text-lima shrink-0' : 'text-destructive shrink-0'}>
                    {log.success ? 'Enviado' : `Falló${log.error ? `: ${log.error}` : ''}`}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
