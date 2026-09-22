'use client';

import { FileText, Film, Trash2, Loader2 } from 'lucide-react';

export type SponsorAssetItem = {
  id: string;
  url: string;
  fileType: string;
  fileName: string;
  uploadedAt?: string;
};

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface SponsorAssetListProps {
  assets: SponsorAssetItem[];
  // Cada subida sigue sin sobreescribirse nunca sola (ver comentario en el
  // modelo SponsorAsset) — onDelete es un borrado explícito a petición del
  // admin o del propio sponsor, no automático. Se omite para dejar la lista
  // de solo lectura.
  onDelete?: (assetId: string) => void;
  deletingId?: string | null;
}

export function SponsorAssetList({ assets, onDelete, deletingId = null }: SponsorAssetListProps) {
  if (!assets?.length) return null;

  return (
    <div className="space-y-2">
      {assets.map((asset) => (
        <div key={asset.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          {asset.fileType.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.url} alt="" className="h-12 w-12 object-contain rounded bg-white shrink-0" />
          ) : (
            <div className="h-12 w-12 flex items-center justify-center rounded bg-background shrink-0">
              {asset.fileType.startsWith('video/') ? (
                <Film className="h-5 w-5 text-muted-foreground" />
              ) : (
                <FileText className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <a href={asset.url} target="_blank" rel="noopener noreferrer" className="text-sm underline truncate block">
              {asset.fileName}
            </a>
            {formatDate(asset.uploadedAt) && (
              <p className="text-xs text-muted-foreground">{formatDate(asset.uploadedAt)}</p>
            )}
          </div>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(asset.id)}
              disabled={deletingId === asset.id}
              aria-label={`Eliminar ${asset.fileName}`}
              className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {deletingId === asset.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
