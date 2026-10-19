'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import '@/components/templates/cine.css';

type Connection = { saveData?: boolean; effectiveType?: string };

/**
 * Fondo de la cabecera de «cine»: el póster (una imagen normal, que es lo que cuenta para la carga) y, encima, el vídeo del cliente.
 * El vídeo NO se pide hasta que el navegador ya ha pintado y solo si procede: no si el visitante pide menos movimiento, ni con el ahorro de
 * datos activado, ni con una conexión 2G. Se pausa cuando sale de pantalla y siempre hay un botón para pausarlo (un vídeo que se mueve solo
 * debe poder detenerse). Sin vídeo, o sin JavaScript, queda el póster.
 */
export function HeroMedia({ video, poster }: { video: string | null; poster: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!video) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const conn = (navigator as Navigator & { connection?: Connection }).connection;
    if (calm || conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    setEnabled(true);
  }, [video]);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !video) return;
    el.src = video;
    el.play().catch(() => {
      /* El navegador puede negar la reproducción automática: se queda el póster y el botón permite probar. */
    });
    // Fuera de pantalla no se gasta batería ni decodificador.
    const io = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting) {
        if (!el.dataset.userPaused) el.play().catch(() => undefined);
      } else el.pause();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, video]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      delete el.dataset.userPaused;
      el.play().catch(() => undefined);
      setPaused(false);
    } else {
      el.dataset.userPaused = '1';
      el.pause();
      setPaused(true);
    }
  };

  return (
    <>
      <div className="cn-hero-media" aria-hidden>
        {poster && (
          // img nativo: son subidas del cliente a Blob y no hay lista de dominios de next/image.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" fetchPriority="high" decoding="async" />
        )}
        {video && <video ref={ref} muted loop playsInline preload="none" data-ready={ready} onPlaying={() => setReady(true)} />}
      </div>
      {enabled && ready && (
        <button type="button" className="cn-media-toggle" onClick={toggle} aria-label={paused ? 'Reproducir el vídeo de la cabecera' : 'Pausar el vídeo de la cabecera'}>
          {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
          {paused ? 'Reproducir' : 'Pausar'}
        </button>
      )}
    </>
  );
}
