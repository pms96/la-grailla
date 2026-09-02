'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CheckCircle, Loader2 } from 'lucide-react';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/utils';

export type ReceiptPrinterStage = 'processing' | 'printing' | 'complete';

type ReceiptPrinterContextValue = { shouldMove: boolean; stage: ReceiptPrinterStage };

const ReceiptPrinterContext = createContext<ReceiptPrinterContextValue | null>(null);

function useReceiptPrinterCtx(component: string) {
  const ctx = useContext(ReceiptPrinterContext);
  if (!ctx) throw new Error(`${component} debe usarse dentro de ReceiptPrinter.Root`);
  return ctx;
}

const easeOut = [0.23, 1, 0.32, 1] as const;
const easeInOut = [0.77, 0, 0.175, 1] as const;

// Ritmo de avance a "golpes" del papel, imitando el arrastre mecánico de una
// impresora térmica real (en vez de un deslizamiento continuo). Expresado
// como el % de "inset" aún oculto en cada paso, no como translateY, para que
// funcione con recibos de alto variable (1 entrada o 10).
const FEED_STEPS = [100, 91, 91, 81, 81, 70, 70, 58, 58, 45, 45, 32, 32, 20, 20, 10, 10, 3, 3, 0];
const FEED_TIMES = [0, 0.075, 0.105, 0.18, 0.21, 0.285, 0.315, 0.39, 0.42, 0.495, 0.525, 0.6, 0.63, 0.705, 0.735, 0.81, 0.84, 0.915, 0.945, 1];

const TOOTH_COUNT = 22;
const TOOTH_DEPTH = 5;
const RECEIPT_CLIP_PATH = (() => {
  const points = Array.from({ length: TOOTH_COUNT * 2 }, (_, index) => {
    const x = 100 - ((index + 1) * 100) / (TOOTH_COUNT * 2);
    const y = index % 2 === 0 ? '100%' : `calc(100% - ${TOOTH_DEPTH}px)`;
    return `${x}% ${y}`;
  }).join(', ');
  return `polygon(0 0, 100% 0, 100% calc(100% - ${TOOTH_DEPTH}px), ${points})`;
})();

const STATUS_LABELS: Record<ReceiptPrinterStage, string> = {
  processing: 'Preparando tu recibo…',
  printing: 'Imprimiendo tu recibo…',
  complete: 'Recibo listo',
};

function Root({
  stage,
  className,
  children,
}: {
  stage: ReceiptPrinterStage;
  className?: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <ReceiptPrinterContext.Provider value={{ shouldMove: !reduceMotion, stage }}>
      <div
        data-stage={stage}
        aria-label="Impresora de recibos"
        className={cn('relative mx-auto flex w-full max-w-sm flex-col items-center', className)}
      >
        {children}
      </div>
    </ReceiptPrinterContext.Provider>
  );
}

function Machine({
  children,
  orderCode,
  className,
}: {
  children: ReactNode;
  orderCode?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'texture-noise relative isolate w-full overflow-hidden rounded-xl border p-3 pb-6',
        'border-[hsl(245_15%_22%)] bg-[hsl(245_28%_10%)]',
        'shadow-[0_16px_32px_-16px_hsl(245_70%_8%/0.7),0_0_0_1px_hsl(245_70%_58%/0.1),inset_0_1px_0_hsl(0_0%_100%/0.05)]',
        className,
      )}
    >
      <div className="relative z-10 flex h-6 items-center justify-between">
        <Logo variant="white" aria-hidden className="h-3.5 w-auto opacity-90" />
        {orderCode ? (
          <span className="font-mono text-xs tracking-wide text-white/35">#{orderCode}</span>
        ) : null}
      </div>
      <div className="relative z-10 mt-2 overflow-hidden rounded-lg border border-white/5 bg-[hsl(245_32%_4%)] p-3 text-white shadow-[inset_0_2px_6px_hsl(0_0%_0%/0.6)]">
        {children}
      </div>
      {/* Ranura de salida del papel */}
      <div
        aria-hidden="true"
        className="absolute inset-x-5 bottom-3 z-40 h-1.5 rounded-full bg-black/70 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]"
      />
    </div>
  );
}

function Status({ children, className }: { children?: ReactNode; className?: string }) {
  const { stage, shouldMove } = useReceiptPrinterCtx('ReceiptPrinter.Status');
  const isComplete = stage === 'complete';
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <span aria-hidden="true" className="relative grid size-4 shrink-0 place-items-center">
        <AnimatePresence mode="wait" initial={false}>
          {isComplete ? (
            <motion.span
              key="ok"
              initial={shouldMove ? { opacity: 0, scale: 0.85 } : false}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: shouldMove ? 0.18 : 0, ease: easeOut }}
              className="text-lima"
            >
              <CheckCircle className="h-4 w-4" />
            </motion.span>
          ) : (
            <motion.span
              key="working"
              initial={shouldMove ? { opacity: 0, scale: 0.85 } : false}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: shouldMove ? 0.18 : 0, ease: easeOut }}
              className="text-white/50"
            >
              <Loader2 className={cn('h-4 w-4', shouldMove && 'animate-spin')} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div role="status" aria-live="polite" className="min-w-0 flex-1 truncate font-mono text-xs text-white/60">
        {children ?? STATUS_LABELS[stage]}
      </div>
    </div>
  );
}

function Output({ children, className }: { children: ReactNode; className?: string }) {
  const { stage, shouldMove } = useReceiptPrinterCtx('ReceiptPrinter.Output');
  const isVisible = stage !== 'processing';
  const stepped = stage === 'printing' && shouldMove;

  return (
    <div className={cn('relative z-0 -mt-2 w-[86%] max-w-full', className)}>
      <motion.div
        initial={false}
        animate={{
          clipPath: stepped
            ? FEED_STEPS.map((p) => `inset(0 0 ${p}% 0)`)
            : `inset(0 0 ${isVisible ? 0 : 100}% 0)`,
          opacity: isVisible ? 1 : 0,
        }}
        transition={{
          clipPath: {
            duration: shouldMove ? 1.6 : 0,
            ease: stepped ? 'linear' : easeInOut,
            times: stepped ? FEED_TIMES : undefined,
          },
          opacity: { duration: shouldMove ? 0.2 : 0 },
        }}
        className="drop-shadow-[0_14px_24px_rgba(0,0,0,0.35)]"
      >
        {children}
      </motion.div>
    </div>
  );
}

function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <article
      style={{ clipPath: RECEIPT_CLIP_PATH }}
      className={cn(
        'texture-noise relative bg-white px-4 pt-5 pb-7 font-mono text-[hsl(240_20%_10%)]',
        className,
      )}
    >
      {children}
    </article>
  );
}

function DashedRule({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('my-3 border-t border-dashed border-black/20', className)} />;
}

export const ReceiptPrinter = {
  DashedRule,
  Machine,
  Output,
  Paper,
  Root,
  Status,
};

/** Orquesta las 3 fases visuales del recibo (preparando → imprimiendo → listo) una vez el pedido está confirmado. */
export function usePrintSequence(ready: boolean): ReceiptPrinterStage {
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState<ReceiptPrinterStage>('processing');

  useEffect(() => {
    if (!ready) return;
    if (reduceMotion) {
      setStage('complete');
      return;
    }
    const t1 = setTimeout(() => setStage('printing'), 450);
    const t2 = setTimeout(() => setStage('complete'), 450 + 1600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [ready, reduceMotion]);

  return stage;
}
