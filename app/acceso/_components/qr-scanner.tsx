'use client';

import { useEffect, useRef, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';

interface QrScannerProps {
  onScan: (code: string) => void;
}

export default function QrScannerComponent({ onScan }: QrScannerProps) {
  const scannerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const html5QrRef = useRef<Html5Qrcode | null>(null);
  const lastScanned = useRef('');
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let mounted = true;

    // html5-qrcode lanza de forma SÍNCRONA (no como promesa rechazada) si se
    // llama a stop() cuando el escáner no está en estado SCANNING/PAUSED (p.
    // ej. sigue inicializando la cámara, o start() nunca llegó a arrancar
    // porque se denegó el permiso). Sin este guard, cambiar de pestaña justo
    // en ese momento tira una excepción no capturada que tumba el árbol de
    // React entero (el usuario lo ve como "no puedo cambiar de pestaña").
    const safeStop = async (scanner: Html5Qrcode) => {
      try {
        if (!scanner.isScanning) return;
        await scanner.stop();
      } catch {
        // Ya estaba parado o nunca llegó a arrancar — nada que hacer.
      }
    };

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
              onScanRef.current?.(decodedText);
              setTimeout(() => { lastScanned.current = ''; }, 3000);
            }
          },
          () => {} // ignore errors
        );

        // El componente se desmontó (cambio de pestaña) mientras start()
        // seguía en vuelo — parar la cámara que acaba de arrancar.
        if (!mounted) await safeStop(scanner);
      } catch {
        if (mounted) setError('No se pudo acceder a la cámara. Asegúrate de dar permiso.');
      }
    };

    init();

    return () => {
      mounted = false;
      if (html5QrRef.current) safeStop(html5QrRef.current);
    };
    // Se monta/desmonta una sola vez — `onScan` cambia de referencia en cada
    // escaneo (depende de `scanning` en access-client.tsx) y si estuviera en
    // las deps, este efecto pararía y reiniciaría la cámara en cada lectura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
