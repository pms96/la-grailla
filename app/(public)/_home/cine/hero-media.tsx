'use client';

import { useEffect, useRef, useState } from 'react';
import { blobImgProps, IMG_SIZES } from '@/lib/images/blob-image';
import { Pause, Play } from 'lucide-react';
import { HERO_VIDEO_MIN_WIDTH, shouldAutoplayHeroVideo } from '@/lib/brand/hero-video';
import '@/components/templates/cine.css';

type Connection = { saveData?: boolean; effectiveType?: string };

/**
 * Fondo de la cabecera de «cine»: el póster (una imagen normal, que es lo que cuenta para la carga) y, encima, el vídeo del cliente.
 * El vídeo NO se pide hasta que la página ha terminado de cargar y el navegador está en reposo, y solo si procede: no si el visitante pide menos
 * movimiento, ni con el ahorro de datos, ni con una conexión 2G/3G, ni en pantallas estrechas (móvil: se queda el póster). Se pausa cuando sale de pantalla y siempre hay un botón para pausarlo (un vídeo que se mueve solo
 * debe poder detenerse). Sin vídeo, o sin JavaScript, queda el póster.
 */
export function HeroMedia({ video, poster }: { video: string | null; poster: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!video) return;
    const conn = (navigator as Navigator & { connection?: Connection }).connection;
    const play = shouldAutoplayHeroVideo({
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      saveData: Boolean(conn?.saveData),
      effectiveType: conn?.effectiveType ?? '',
      wideScreen: window.matchMedia(`(min-width: ${HERO_VIDEO_MIN_WIDTH}px)`).matches,
    });
    if (!play) return;
    // No antes de que la página haya terminado de cargar (póster, tipografías y carteles) y el navegador esté en reposo: el vídeo es lo último.
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => setEnabled(true);
    const whenIdle = () => {
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(start, { timeout: 2000 });
      else timer = setTimeout(start, 300);
    };
    if (document.readyState === 'complete') whenIdle();
    else window.addEventListener('load', whenIdle, { once: true });
    return () => {
      window.removeEventListener('load', whenIdle);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
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
          <img {...blobImgProps(poster, { sizes: IMG_SIZES.full })} alt="" fetchPriority="high" decoding="async" />
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
