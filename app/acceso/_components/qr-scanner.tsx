'use client';

import { useEffect, useRef, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';
import { Loader2 } from 'lucide-react';

interface QrScannerProps {
  onScan: (code: string) => void;
}

export default function QrScannerComponent({ onScan }: QrScannerProps) {
  const scannerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const html5QrRef = useRef<Html5Qrcode | null>(null);
  const lastScanned = useRef('');

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!mounted || !scannerRef.current) return;

        const scanner = new Html5Qrcode('qr-reader');
        html5QrRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          (decodedText: string) => {
            if (decodedText && decodedText !== lastScanned.current) {
              lastScanned.current = decodedText;
              onScan?.(decodedText);
              setTimeout(() => { lastScanned.current = ''; }, 3000);
            }
          },
          () => {} // ignore errors
        );
      } catch {
        if (mounted) setError('No se pudo acceder a la cámara. Asegúrate de dar permiso.');
      }
    };

    init();

    return () => {
      mounted = false;
      if (html5QrRef.current) {
        html5QrRef.current.stop?.().catch?.(() => {});
      }
    };
  }, [onScan]);

  if (error) {
    return <p className="text-sm text-destructive text-center py-4">{error}</p>;
  }

  return (
    <div>
      <div id="qr-reader" ref={scannerRef} className="w-full rounded-lg overflow-hidden" />
      <p className="text-xs text-muted-foreground text-center mt-2">Apunta la cámara al código QR</p>
    </div>
  );
}
