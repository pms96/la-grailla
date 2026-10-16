'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Save, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/layouts/page-header';
import {
  SECTION_CONFIG_KEYS,
  SECTION_DEFS,
  SECTION_KINDS,
  emptySection,
  hasContent,
  invalidSectionValue,
  parseSection,
  serializeSection,
  type ContentSection,
  type SectionKind,
} from '@/lib/content/sections';
import { SectionEditor } from './section-editor';

type Drafts = Record<SectionKind, ContentSection>;

const blankDrafts = (): Drafts => ({ servicios: emptySection(), proyectos: emptySection(), equipo: emptySection(), faq: emptySection() });

/* Secciones de la portada que escribe el propio cliente (servicios, proyectos, equipo, preguntas frecuentes). Son del núcleo: no dependen de
 * ningún módulo. Se guardan por la API de configuración, una clave por sección (lib/content/sections.ts). Una sección sin elementos no se
 * muestra en la web. */
export default function SeccionesPage() {
  const [drafts, setDrafts] = useState<Drafts>(blankDrafts);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((rows: { key: string; value: string }[]) => {
        const next = blankDrafts();
        for (const kind of SECTION_KINDS) {
          const row = Array.isArray(rows) ? rows.find((c) => c.key === SECTION_CONFIG_KEYS[kind]) : undefined;
          next[kind] = parseSection(row?.value, kind);
        }
        setDrafts(next);
      })
      .catch(() => toast.error('No se han podido cargar las secciones'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    // Un elemento sin título no se puede mostrar: se descarta al guardar y se avisa para que no parezca que se ha perdido por error.
    const prepared = SECTION_KINDS.map((kind) => {
      const items = drafts[kind].items.filter((i) => i.title.trim() !== '');
      return { kind, section: { ...drafts[kind], items }, dropped: drafts[kind].items.length - items.length };
    });
    // Se valida lo que ha escrito la persona (no lo ya limpiado): un enlace mal escrito se avisa, no se borra en silencio. Y se avisa ANTES de
    // enviar nada, para no dejar guardada solo la mitad de las secciones.
    for (const p of prepared) {
      const problem = invalidSectionValue(JSON.stringify(p.section), p.kind);
      if (problem) {
        toast.error(`${SECTION_DEFS[p.kind].label}: ${problem}`);
        return;
      }
    }
    const configs = prepared.map((p) => ({ key: SECTION_CONFIG_KEYS[p.kind], value: serializeSection(p.section, p.kind) }));
    const dropped = prepared.reduce((n, p) => n + p.dropped, 0);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configs: configs.map(({ key, value }) => ({ key, value, label: key, group: 'contenido' })) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? 'Error al guardar');
        return;
      }
      // Lo que queda guardado es lo que se ve: se vuelve a leer del borrador normalizado (sin elementos vacíos).
      setDrafts((prev) => {
        const next = blankDrafts();
        for (const kind of SECTION_KINDS) next[kind] = parseSection(serializeSection(prev[kind], kind), kind);
        return next;
      });
      toast.success(dropped > 0 ? `Guardado. Se han quitado ${dropped} elemento${dropped === 1 ? '' : 's'} sin título.` : 'Secciones guardadas');
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Secciones"
        description="Servicios, proyectos, equipo y preguntas frecuentes de tu portada. Una sección sin elementos no se muestra."
        actions={
          <>
            <Button asChild variant="ghost" className="gap-2">
              <Link href="/" target="_blank">
                <ExternalLink className="h-4 w-4" /> Ver portada
              </Link>
            </Button>
            <Button onClick={save} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar
            </Button>
          </>
        }
      />

      <Tabs defaultValue="servicios">
        <TabsList className="h-auto flex-wrap">
          {SECTION_KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind} className="gap-2">
              {SECTION_DEFS[kind].label}
              {hasContent(drafts[kind]) && <span className="text-xs text-muted-foreground">{drafts[kind].items.length}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTION_KINDS.map((kind) => (
          <TabsContent key={kind} value={kind}>
            <Card>
              <CardContent className="p-6">
                <SectionEditor kind={kind} value={drafts[kind]} onChange={(next) => setDrafts((prev) => ({ ...prev, [kind]: next }))} />
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
