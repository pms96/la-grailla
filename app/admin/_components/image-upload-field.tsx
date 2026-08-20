'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Loader2, Upload, X, ImageOff } from 'lucide-react';
import { toast } from 'sonner';

type ImageUploadFieldProps = {
  value: string;
  onChange: (url: string) => void;
  prefix: string;
  className?: string;
};

export function ImageUploadField({ value, onChange, prefix, className }: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('prefix', prefix);
      const res = await fetch('/api/admin/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok || !data?.url) {
        toast.error(data?.error ?? 'No se ha podido subir la imagen');
        return;
      }
      onChange(data.url);
    } catch {
      toast.error('Error de conexión al subir la imagen');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={className}>
      <div className="relative aspect-square w-28 rounded-md overflow-hidden bg-muted border border-border">
        {value ? (
          <Image src={value} alt="" fill className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" /> {value ? 'Cambiar' : 'Subir imagen'}
        </Button>
        {value && (
          <Button type="button" variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={() => onChange('')}>
            <X className="h-3.5 w-3.5" /> Quitar
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}
