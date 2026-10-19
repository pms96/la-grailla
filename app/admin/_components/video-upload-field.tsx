'use client';

import { useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { Loader2, Upload, X, Film } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useBrand } from '@/components/brand-provider';
import { HERO_VIDEO_TYPES, heroVideoBlobPrefix, heroVideoFileProblem } from '@/lib/brand/hero-video';

type Props = {
  value: string;
  onChange: (url: string) => void;
  /** Nombre del campo para lectores de pantalla («Cambiar vídeo de cabecera»). */
  label?: string;
};

/** Campo para subir un vídeo (MP4 o WebM) directamente a Vercel Blob. Muestra el avance, una vista previa muda y un botón para quitarlo. */
export function VideoUploadField({ value, onChange, label }: Props) {
  const { blobPrefix } = useBrand();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = heroVideoFileProblem(file);
    if (problem) {
      toast.error(problem);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setProgress(0);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const blob = await upload(`${heroVideoBlobPrefix(blobPrefix)}${crypto.randomUUID()}-${safe}`, file, {
        access: 'public',
        handleUploadUrl: '/api/admin/theme/video-upload-token',
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
      });
      onChange(blob.url);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'No se ha podido subir el vídeo');
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const uploading = progress !== null;
  return (
    <div>
      <div className="relative aspect-video w-64 overflow-hidden rounded-md border border-border bg-muted">
        {value ? (
          // Vista previa muda y sin reproducción automática: solo para comprobar que es el vídeo correcto.
          <video src={value} muted playsInline controls preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Film className="h-6 w-6" />
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/80">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-xs" aria-live="polite">{progress}%</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-2" disabled={uploading} onClick={() => inputRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> {value ? 'Cambiar' : 'Subir vídeo'}
          {label && <span className="sr-only"> {label}</span>}
        </Button>
        {value && !uploading && (
          <Button type="button" variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={() => onChange('')}>
            <X className="h-3.5 w-3.5" /> Quitar{label && <span className="sr-only"> {label}</span>}
          </Button>
        )}
      </div>
      <input ref={inputRef} type="file" accept={HERO_VIDEO_TYPES.join(',')} className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
    </div>
  );
}
