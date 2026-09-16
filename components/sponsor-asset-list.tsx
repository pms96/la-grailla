import { FileText, Film } from 'lucide-react';

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

// Lista de todo lo que se ha subido — nunca se borra (cada subida es una fila
// nueva, ver comentario en el modelo SponsorAsset), así que aquí se ve el
// historial completo, no solo el último archivo.
export function SponsorAssetList({ assets }: { assets: SponsorAssetItem[] }) {
  if (assets.length === 0) return null;

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
          <div className="min-w-0">
            <a href={asset.url} target="_blank" rel="noopener noreferrer" className="text-sm underline truncate block">
              {asset.fileName}
            </a>
            {formatDate(asset.uploadedAt) && (
              <p className="text-xs text-muted-foreground">{formatDate(asset.uploadedAt)}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
