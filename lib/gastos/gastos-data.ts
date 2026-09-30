import { prisma } from '@/lib/prisma';
import { importeGastoConIva } from '@/lib/gasto-calc';

export type GastoParaExport = {
  fecha: Date;
  categoria: string;
  concepto: string;
  proveedor: string | null;
  numDocumento: string | null;
  tipoDocumento: string;
  importeSinIva: number;
  ivaPercent: number;
  importeConIva: number;
  notas: string | null;
};

export type GastosExportData = {
  temporada: { nombre: string; anio: number };
  gastos: GastoParaExport[];
  total: number;
};

export async function getGastosParaExport(temporadaId: string): Promise<GastosExportData | null> {
  const temporada = await prisma.temporada.findUnique({ where: { id: temporadaId } });
  if (!temporada) return null;

  const gastos = await prisma.gasto.findMany({
    where: { temporadaId },
    orderBy: { fecha: 'asc' },
    include: { proveedor: true },
  });

  const rows: GastoParaExport[] = gastos.map((g) => ({
    fecha: g.fecha,
    categoria: g.categoria,
    concepto: g.concepto,
    proveedor: g.proveedor?.nombre ?? null,
    numDocumento: g.numDocumento,
    tipoDocumento: g.tipoDocumento,
    importeSinIva: g.importeSinIva,
    ivaPercent: g.ivaPercent,
    importeConIva: importeGastoConIva(g.importeSinIva, g.ivaPercent),
    notas: g.notas,
  }));

  const total = Math.round(rows.reduce((acc, r) => acc + r.importeConIva, 0) * 100) / 100;

  return { temporada: { nombre: temporada.nombre, anio: temporada.anio }, gastos: rows, total };
}
