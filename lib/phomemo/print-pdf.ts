import type { PDFPageProxy } from 'pdfjs-dist';
import { M04S_PAPER } from './constants';
import type { PhomemoM04S } from './ble';
import { canvasToMonoRaster } from './raster';

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  return pdfjs;
}

async function renderPageToCanvas(page: PDFPageProxy, targetWidthPx: number): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidthPx / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo preparar la entrada para imprimir');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  return canvas;
}

/** Renderiza cada página del PDF de taquilla y la manda a la M04S. */
export async function printTicketPdf(
  printer: PhomemoM04S,
  pdfBytes: ArrayBuffer,
  onPage?: (current: number, total: number) => void
): Promise<void> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) });
  const pdf = await task.promise;
  const widthPx = M04S_PAPER.widthPx;

  for (let i = 1; i <= pdf.numPages; i++) {
    onPage?.(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const canvas = await renderPageToCanvas(page, widthPx);
    const raster = canvasToMonoRaster(canvas, M04S_PAPER.widthBytes);
    await printer.printRaster(raster);
  }
}
