'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Clapperboard, Sparkles, Check, X as XIcon, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';

type SponsorPortalStatus =
  | 'PENDIENTE_MATERIALES'
  | 'PENDIENTE_REVISION'
  | 'LISTO_PARA_GENERAR'
  | 'PROMPT_GENERADO'
  | 'APROBADO_PARA_VIDEO'
  | 'RECHAZADO';

type SponsorAsset = { id: string; url: string; fileType: string; fileName: string };
type SponsorVideoPrompt = { promptEs: string; promptEn: string; approvedAt: string | null; notifiedAt: string | null };
type PromptGenerationLog = { id: string; attemptNumber: number; success: boolean; errorMessage: string | null; createdAt: string };

type SponsorRow = {
  id: string;
  status: SponsorPortalStatus;
  generationCount: number;
  maxGenerations: number;
  isGenerating: boolean;
  currentAsset: SponsorAsset | null;
  videoPrompt: SponsorVideoPrompt | null;
  sponsorRequest: { companyName: string; contactName: string; email: string };
};

type SponsorDetail = SponsorRow & {
  guidedAnswers: Record<string, string> | null;
  freeText: string | null;
  generationLogs: PromptGenerationLog[];
};

const statusLabels: Record<SponsorPortalStatus, string> = {
  PENDIENTE_MATERIALES: 'Pendiente de materiales',
  PENDIENTE_REVISION: 'Pendiente de revisión',
  LISTO_PARA_GENERAR: 'Listo para generar',
  PROMPT_GENERADO: 'Prompt generado',
  APROBADO_PARA_VIDEO: 'Aprobado para vídeo',
  RECHAZADO: 'Rechazado',
};

export default function SponsorsPortalAdminPage() {
  const [sponsors, setSponsors] = useState<SponsorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SponsorDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promptDraft, setPromptDraft] = useState({ promptEs: '', promptEn: '' });

  const fetchSponsors = () => {
    const qs = statusFilter ? `?status=${statusFilter}` : '';
    fetch(`/api/admin/sponsors-portal${qs}`)
      .then((r) => r.json())
      .then((d) => setSponsors(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    fetchSponsors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const openDetail = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetailLoading(true);
    fetch(`/api/admin/sponsors-portal/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setDetail(d);
        setPromptDraft({ promptEs: d?.videoPrompt?.promptEs ?? '', promptEn: d?.videoPrompt?.promptEn ?? '' });
      })
      .catch(() => toast.error('No se pudo cargar el detalle'))
      .finally(() => setDetailLoading(false));
  };

  const refreshAll = (id: string) => {
    fetchSponsors();
    openDetail(id);
    setExpandedId(id);
  };

  const markReady = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${id}/ready`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      toast.success('Marcado como listo para generar');
      setExpandedId(null);
      setDetail(null);
      fetchSponsors();
      setTimeout(() => openDetail(id), 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  };

  const generate = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${id}/generate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error ?? 'Error al generar');
      toast.success('Prompt generado');
      setExpandedId(null);
      setDetail(null);
      fetchSponsors();
      setTimeout(() => openDetail(id), 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al generar');
      fetchSponsors();
    } finally {
      setBusy(false);
    }
  };

  const savePrompt = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${id}/prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptDraft),
      });
      if (!res.ok) throw new Error();
      toast.success('Prompt guardado');
    } catch {
      toast.error('No se pudo guardar el prompt');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error);
      toast.success('Aprobado para vídeo');
      refreshAll(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/admin/sponsors-portal/${id}/reject`, { method: 'POST' });
      toast.success('Rechazado');
      refreshAll(id);
    } catch {
      toast.error('Error');
    } finally {
      setBusy(false);
    }
  };

  const notify = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sponsors-portal/${id}/notify`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error('No se pudo enviar el email');
      toast.success('Sponsor notificado por email');
      refreshAll(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Portal de Sponsors" description="Materiales, formulario guiado y generación de prompt de vídeo con Abacus.AI" />

      <Select value={statusFilter || 'ALL'} onValueChange={(v) => setStatusFilter(v === 'ALL' ? '' : v)}>
        <SelectTrigger className="w-64"><SelectValue placeholder="Todos los estados" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Todos los estados</SelectItem>
          {Object.entries(statusLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
        </SelectContent>
      </Select>

      {(sponsors?.length ?? 0) === 0 ? (
        <div className="text-center py-20">
          <Clapperboard className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No hay sponsors en este estado</p>
        </div>
      ) : (
        <div className="space-y-4">
          {sponsors.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between cursor-pointer" onClick={() => openDetail(s.id)}>
                  <div className="flex items-center gap-3">
                    {s.currentAsset && s.currentAsset.fileType.startsWith('image/') && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.currentAsset.url} alt="" className="h-10 w-10 rounded object-contain bg-muted" />
                    )}
                    <div>
                      <p className="font-medium">{s.sponsorRequest?.companyName}</p>
                      <p className="text-xs text-muted-foreground">{s.sponsorRequest?.contactName} · {s.sponsorRequest?.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{s.generationCount}/{s.maxGenerations} intentos</span>
                    <Badge>{statusLabels[s.status]}</Badge>
                  </div>
                </div>

                {expandedId === s.id && (
                  <div className="pt-3 border-t space-y-4">
                    {detailLoading || !detail ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    ) : (
                      <>
                        {detail.freeText && (
                          <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded">{detail.freeText}</p>
                        )}
                        {detail.guidedAnswers && Object.keys(detail.guidedAnswers).length > 0 && (
                          <div className="text-sm grid grid-cols-2 gap-2">
                            {Object.entries(detail.guidedAnswers).map(([k, v]) => (
                              <div key={k}><span className="text-muted-foreground">{k}:</span> {v}</div>
                            ))}
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                          {s.status === 'PENDIENTE_REVISION' && (
                            <Button size="sm" disabled={busy} onClick={() => markReady(s.id)}>Marcar listo para generar</Button>
                          )}
                          {(s.status === 'LISTO_PARA_GENERAR' || s.status === 'PROMPT_GENERADO') && (
                            <Button
                              size="sm"
                              disabled={busy || s.isGenerating || s.generationCount >= s.maxGenerations}
                              onClick={() => generate(s.id)}
                              className="gap-2"
                            >
                              <Sparkles className="h-3.5 w-3.5" /> Generar con Abacus.AI
                            </Button>
                          )}
                          {detail.videoPrompt && s.status !== 'APROBADO_PARA_VIDEO' && s.status !== 'RECHAZADO' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => approve(s.id)} className="gap-2">
                              <Check className="h-3.5 w-3.5" /> Aprobar para vídeo
                            </Button>
                          )}
                          {s.status !== 'RECHAZADO' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => reject(s.id)} className="gap-2">
                              <XIcon className="h-3.5 w-3.5" /> Rechazar
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => notify(s.id)} className="gap-2">
                            <Mail className="h-3.5 w-3.5" /> Notificar por email
                          </Button>
                        </div>

                        {detail.videoPrompt && (
                          <Tabs defaultValue="es">
                            <TabsList>
                              <TabsTrigger value="es">Español</TabsTrigger>
                              <TabsTrigger value="en">English</TabsTrigger>
                            </TabsList>
                            <TabsContent value="es">
                              <Textarea
                                rows={6}
                                value={promptDraft.promptEs}
                                onChange={(e) => setPromptDraft((p) => ({ ...p, promptEs: e.target.value }))}
                              />
                            </TabsContent>
                            <TabsContent value="en">
                              <Textarea
                                rows={6}
                                value={promptDraft.promptEn}
                                onChange={(e) => setPromptDraft((p) => ({ ...p, promptEn: e.target.value }))}
                              />
                            </TabsContent>
                            <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => savePrompt(s.id)}>
                              Guardar cambios
                            </Button>
                          </Tabs>
                        )}

                        {detail.generationLogs?.length > 0 && (
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p className="font-medium">Historial de intentos</p>
                            {detail.generationLogs.map((log) => (
                              <p key={log.id}>
                                #{log.attemptNumber} — {new Date(log.createdAt).toLocaleString('es-ES')} —{' '}
                                {log.success ? 'éxito' : `error: ${log.errorMessage}`}
                              </p>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
