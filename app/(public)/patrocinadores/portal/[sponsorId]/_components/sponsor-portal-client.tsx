'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, Upload, CheckCircle, Clapperboard, SearchX, Pencil, Sparkles, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { FadeIn } from '@/components/ui/animate';
import { cn } from '@/lib/utils';

const GUIDED_QUESTIONS: { key: string; label: string; placeholder: string }[] = [
  { key: 'estiloVisual', label: 'Estilo visual', placeholder: 'Ej. minimalista, retro, neón, elegante...' },
  { key: 'ambiente', label: 'Ambiente / vibra deseada', placeholder: 'Ej. enérgico, sofisticado, festivo...' },
  { key: 'tipoAnimacion', label: 'Tipo de animación', placeholder: 'Ej. revelación progresiva, glitch, partículas...' },
  { key: 'coloresClave', label: 'Colores clave de tu marca', placeholder: 'Ej. azul #1a2b3c y dorado' },
  { key: 'ritmo', label: 'Ritmo', placeholder: 'Ej. pausado y cinematográfico, o rápido y dinámico' },
  { key: 'enfoqueMarca', label: 'Enfoque de marca', placeholder: '¿Qué quieres que transmita tu marca?' },
];

// Pasos tal como los ve el sponsor — LISTO_PARA_GENERAR es un detalle interno
// del panel admin, de cara al sponsor sigue siendo "en revisión".
const STEPS = ['Materiales', 'En revisión', 'Propuesta de vídeo', 'Aprobado'] as const;
function stepIndexFor(status: string): number {
  switch (status) {
    case 'PENDIENTE_MATERIALES': return 0;
    case 'PENDIENTE_REVISION':
    case 'LISTO_PARA_GENERAR': return 1;
    case 'PROMPT_GENERADO': return 2;
    case 'APROBADO_PARA_VIDEO': return 3;
    default: return 0;
  }
}

// Solo tiene sentido comprobar solo si hay novedades mientras el equipo está
// trabajando en ello — ni mientras el sponsor sigue rellenando (nada que
// consultar todavía) ni una vez cerrado (aprobado/rechazado, ya no cambia).
const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 20;

type SponsorData = {
  id: string;
  status: string;
  guidedAnswers: Record<string, string> | null;
  freeText: string | null;
  currentAsset: { url: string; fileType: string; fileName: string } | null;
  videoPrompt: { promptEs: string; promptEn: string; approvedAt: string | null } | null;
  sponsorRequest: { companyName: string };
};

function SponsorStepper({ status }: { status: string }) {
  if (status === 'RECHAZADO') {
    return (
      <div className="text-sm text-muted-foreground">Solicitud no aprobada en esta ocasión.</div>
    );
  }
  const active = stepIndexFor(status);
  return (
    <div className="flex items-center gap-1 sm:gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-1 sm:gap-2 flex-1 last:flex-none">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <div
              className={cn(
                'h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                i < active ? 'bg-lima text-background' : i === active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {i < active ? '✓' : i + 1}
            </div>
            <span className={cn('text-xs text-center leading-tight max-w-[4.5rem]', i === active ? 'font-semibold' : 'text-muted-foreground')}>
              {label}
            </span>
          </div>
          {i < STEPS.length - 1 && <div className={cn('h-0.5 flex-1 rounded', i < active ? 'bg-lima' : 'bg-muted')} />}
        </div>
      ))}
    </div>
  );
}

export default function SponsorPortalClient({ sponsorId, accessToken }: { sponsorId: string; accessToken: string }) {
  const [sponsor, setSponsor] = useState<SponsorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollCount = useRef(0);

  const tokenQs = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';

  const fetchSponsor = (opts?: { silent?: boolean }) => {
    fetch(`/api/patrocinadores/${sponsorId}${tokenQs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('not_found');
        return r.json();
      })
      .then((data: SponsorData) => {
        setSponsor(data);
        setAnswers(data?.guidedAnswers ?? {});
        setFreeText(data?.freeText ?? '');
        if (!hasInitialized) {
          // La primera vez: si ya hay materiales enviados, empieza colapsado
          // en el resumen — si no, abierto directamente en el formulario.
          setEditing(!(data?.currentAsset && data?.guidedAnswers));
          setHasInitialized(true);
        }
      })
      .catch(() => {
        if (!opts?.silent) setNotFound(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSponsor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sponsorId]);

  // Mientras el equipo está revisando/preparando la propuesta, refrescamos
  // solos de vez en cuando — así si aprueban o generan el prompt mientras el
  // sponsor tiene la pestaña abierta, lo ve sin tener que recargar a mano.
  useEffect(() => {
    if (!sponsor) return;
    const waitingOnUs = ['PENDIENTE_REVISION', 'LISTO_PARA_GENERAR', 'PROMPT_GENERADO'].includes(sponsor.status);
    if (!waitingOnUs || pollCount.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      pollCount.current += 1;
      fetchSponsor({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sponsor?.status]);

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/patrocinadores/${sponsorId}/logo${tokenQs}`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Error al subir el archivo');
      toast.success('Logo subido correctamente');
      fetchSponsor();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al subir el archivo');
    } finally {
      setUploading(false);
    }
  };

  const saveCreativity = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/patrocinadores/${sponsorId}/creatividad${tokenQs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidedAnswers: answers, freeText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo guardar');
      toast.success('Guardado — el equipo de La Grailla revisará tus materiales');
      setSponsor(data);
      if (data?.currentAsset || sponsor?.currentAsset) setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Cargando tu portal...</p>
      </div>
    );
  }

  if (notFound || !sponsor) {
    return (
      <div className="text-center py-20 space-y-3">
        <SearchX className="h-12 w-12 text-muted-foreground mx-auto" />
        <h1 className="font-display text-xl font-bold">No hemos encontrado tu portal</h1>
        <p className="text-sm text-muted-foreground">
          Revisa que el enlace sea el que recibiste por email, o escríbenos a{' '}
          <a href="mailto:grupolagrailla@gmail.com" className="underline">grupolagrailla@gmail.com</a>.
        </p>
      </div>
    );
  }

  const isFinal = sponsor.status === 'APROBADO_PARA_VIDEO' || sponsor.status === 'RECHAZADO';
  const hasSubmitted = Boolean(sponsor.currentAsset && sponsor.guidedAnswers);
  const showForm = editing || !hasSubmitted;

  const statusNote: Record<string, string> = {
    PENDIENTE_MATERIALES: 'Sube tu logo y cuéntanos cómo lo imaginas para que podamos empezar.',
    PENDIENTE_REVISION: 'Recibido — nuestro equipo está revisando tus materiales. Puedes editarlos mientras tanto si cambias de idea.',
    LISTO_PARA_GENERAR: 'Tus materiales están revisados y en cola para generar la propuesta de vídeo.',
    PROMPT_GENERADO: 'Ya tenemos una propuesta de vídeo lista — la puedes ver más abajo.',
    APROBADO_PARA_VIDEO: 'Tu vídeo ha sido aprobado y está en producción. ¡Gracias por confiar en La Grailla!',
    RECHAZADO: 'Nos pondremos en contacto contigo sobre tu solicitud de patrocinio.',
  };

  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="text-center space-y-1">
          <Clapperboard className="h-10 w-10 text-primary mx-auto mb-2" />
          <h1 className="font-display text-2xl font-bold">Portal de patrocinador</h1>
          <p className="text-muted-foreground">{sponsor.sponsorRequest?.companyName}</p>
        </div>

        <Card>
          <CardContent className="p-6 space-y-4">
            <SponsorStepper status={sponsor.status} />
            <Alert variant={sponsor.status === 'RECHAZADO' ? 'destructive' : 'default'} className="gap-2">
              {sponsor.status === 'APROBADO_PARA_VIDEO' ? <CheckCircle className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
              <AlertDescription>{statusNote[sponsor.status] ?? 'Hay novedades sobre tu patrocinio.'}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {sponsor.videoPrompt && (
          <Card>
            <CardContent className="p-6 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <h2 className="font-display font-bold text-lg">Propuesta de vídeo</h2>
                <Badge variant={sponsor.videoPrompt.approvedAt ? 'default' : 'secondary'}>
                  {sponsor.videoPrompt.approvedAt ? 'Aprobada' : 'Pendiente de aprobación final'}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{sponsor.videoPrompt.promptEs}</p>
            </CardContent>
          </Card>
        )}

        {!isFinal && hasSubmitted && !editing && (
          <Card>
            <CardContent className="p-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {sponsor.currentAsset?.fileType.startsWith('image/') && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={sponsor.currentAsset.url} alt="Tu logo" className="h-12 w-12 object-contain rounded bg-white" />
                )}
                <div>
                  <p className="font-medium text-sm">Materiales enviados</p>
                  <p className="text-xs text-muted-foreground">{sponsor.currentAsset?.fileName}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </Button>
            </CardContent>
          </Card>
        )}

        {!isFinal && showForm && (
          <>
            {editing && hasSubmitted && (
              <p className="text-xs text-muted-foreground text-center -mb-2">
                Editar tus materiales los vuelve a poner en revisión aunque ya estuvieran aprobados internamente.
              </p>
            )}
            <Card>
              <CardContent className="p-6 space-y-4">
                <div>
                  <h2 className="font-display font-bold text-lg">Tu logotipo</h2>
                  <p className="text-sm text-muted-foreground">PNG, JPG, SVG, PDF o un vídeo corto de referencia.</p>
                </div>

                {sponsor.currentAsset && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    {sponsor.currentAsset.fileType.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={sponsor.currentAsset.url} alt="Logo actual" className="h-16 w-16 object-contain rounded bg-white" />
                    ) : (
                      <Badge variant="secondary">{sponsor.currentAsset.fileType}</Badge>
                    )}
                    <p className="text-sm">{sponsor.currentAsset.fileName}</p>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,application/pdf,video/mp4,video/quicktime"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadFile(file);
                  }}
                />
                <Button variant="outline" disabled={uploading} onClick={() => fileInputRef.current?.click()} className="gap-2">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {sponsor.currentAsset ? 'Reemplazar archivo' : 'Subir archivo'}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6 space-y-4">
                <h2 className="font-display font-bold text-lg">Cuéntanos cómo lo imaginas</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  {GUIDED_QUESTIONS.map((q) => (
                    <div key={q.key}>
                      <label className="text-sm font-medium mb-1 block">{q.label}</label>
                      <Input
                        value={answers[q.key] ?? ''}
                        placeholder={q.placeholder}
                        onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Cualquier otra idea o referencia</label>
                  <Textarea rows={5} value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="Sin límite de caracteres — cuéntanos todo lo que consideres útil." />
                </div>
                <div className="flex gap-2">
                  <Button disabled={saving} onClick={saveCreativity}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar'}
                  </Button>
                  {hasSubmitted && (
                    <Button variant="ghost" disabled={saving} onClick={() => setEditing(false)}>Cancelar</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </FadeIn>
  );
}
