'use client';

import { useId } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfigField } from '@/app/admin/_components/config-field';
import { ImageUploadField } from '@/app/admin/_components/image-upload-field';
import { SECTION_DEFS, SECTION_LIMITS, emptyItem, type ContentSection, type SectionItem, type SectionKind } from '@/lib/content/sections';

type Props = {
  kind: SectionKind;
  value: ContentSection;
  onChange: (next: ContentSection) => void;
};

/** Editor de una sección de la portada: título, introducción y una lista de elementos que se pueden ordenar. Solo muestra los campos que esa
 *  sección usa (las preguntas frecuentes no llevan imagen, el equipo no lleva enlace…). */
export function SectionEditor({ kind, value, onChange }: Props) {
  const uid = useId();
  const def = SECTION_DEFS[kind];
  const set = (patch: Partial<ContentSection>) => onChange({ ...value, ...patch });
  const setItem = (index: number, patch: Partial<SectionItem>) => set({ items: value.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) });
  const remove = (index: number) => set({ items: value.items.filter((_, i) => i !== index) });
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= value.items.length) return;
    const items = [...value.items];
    [items[index], items[to]] = [items[to]!, items[index]!];
    set({ items });
  };
  const full = value.items.length >= SECTION_LIMITS.items;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <ConfigField
          label="Título de la sección"
          value={value.title}
          onChange={(v) => set({ title: v })}
          placeholder={`Por defecto: «${def.defaultTitle}»`}
        />
        <ConfigField label="Frase de introducción (opcional)" value={value.intro} onChange={(v) => set({ intro: v })} />
      </div>

      {value.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {def.labels.empty} La sección no se muestra en tu web hasta que haya al menos uno.
        </p>
      ) : (
        <ol className="space-y-4">
          {value.items.map((item, i) => (
            <li key={i} className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {def.labels.title} {i + 1}
                </p>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Subir ${def.labels.title.toLowerCase()} ${i + 1}`}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" disabled={i === value.items.length - 1} onClick={() => move(i, 1)} aria-label={`Bajar ${def.labels.title.toLowerCase()} ${i + 1}`}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="text-muted-foreground" onClick={() => remove(i)} aria-label={`Quitar ${def.labels.title.toLowerCase()} ${i + 1}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className={def.fields.image ? 'grid gap-4 sm:grid-cols-[7rem_1fr]' : 'grid gap-4'}>
                {def.fields.image && (
                  <ImageUploadField
                    value={item.imageUrl}
                    onChange={(url) => setItem(i, { imageUrl: url })}
                    prefix="sections"
                    label={`de ${def.labels.title.toLowerCase()} ${i + 1}`}
                  />
                )}
                <div className="space-y-4">
                  <div className={def.fields.meta ? 'grid gap-4 sm:grid-cols-2' : undefined}>
                    <div>
                      <Label htmlFor={`${uid}-${i}-title`}>{def.labels.title}</Label>
                      <Input id={`${uid}-${i}-title`} className="mt-1" value={item.title} maxLength={SECTION_LIMITS.itemTitle} onChange={(e) => setItem(i, { title: e.target.value })} />
                    </div>
                    {def.fields.meta && (
                      <div>
                        <Label htmlFor={`${uid}-${i}-meta`}>{def.labels.meta}</Label>
                        <Input id={`${uid}-${i}-meta`} className="mt-1" value={item.meta} maxLength={SECTION_LIMITS.meta} onChange={(e) => setItem(i, { meta: e.target.value })} />
                      </div>
                    )}
                  </div>
                  <div>
                    <Label htmlFor={`${uid}-${i}-text`}>{def.labels.text}</Label>
                    <Textarea id={`${uid}-${i}-text`} className="mt-1" rows={kind === 'faq' ? 4 : 3} value={item.text} maxLength={SECTION_LIMITS.text} onChange={(e) => setItem(i, { text: e.target.value })} />
                  </div>
                  {def.fields.href && (
                    <div>
                      <Label htmlFor={`${uid}-${i}-href`}>Enlace (opcional)</Label>
                      <Input id={`${uid}-${i}-href`} className="mt-1" value={item.href} maxLength={SECTION_LIMITS.href} placeholder="https://… o /contacto" onChange={(e) => setItem(i, { href: e.target.value })} />
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" className="gap-2" disabled={full} onClick={() => set({ items: [...value.items, emptyItem()] })}>
          <Plus className="h-3.5 w-3.5" /> {def.labels.add}
        </Button>
        {full && <p className="text-xs text-muted-foreground">Máximo {SECTION_LIMITS.items}.</p>}
      </div>
    </div>
  );
}
