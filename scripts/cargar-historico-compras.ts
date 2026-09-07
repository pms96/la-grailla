// Carga el histórico de compras de la Temporada 2025 (facturas/albaranes de
// Distribuciones Francisco Ramírez Velasco SL, Sánchez-Garrido e Hijos SL y
// Exclusivas La Trabuquense SL) en el módulo de Compras, y precarga el Plan
// de Compra de la Temporada actual con esa misma cantidad como propuesta de
// partida (único año de referencia disponible — no hay más años ni más
// proveedores en este histórico, por decisión explícita del cliente).
//
// Idempotente: se puede re-ejecutar sin duplicar nada (Proveedor/Articulo se
// buscan por nombre exacto antes de crear; Precio/Consumo/Plan usan upsert).
// El Plan de Compra NO se sobreescribe en un re-run si ya existe, para no
// pisar ajustes manuales que el admin haya hecho desde el panel.
//
// Ejecutar con:
//   npx tsx --require dotenv/config scripts/cargar-historico-compras.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPORADA_HISTORICA = { anio: 2025, nombre: 'Feria La Grailla 2025' };
const TEMPORADA_ACTUAL = { anio: 2026, nombre: 'Feria La Grailla 2026' };

const PROVEEDORES = {
  ramirez: {
    nombre: 'Distribuciones Francisco Ramírez Velasco SL',
    telefono: '957531027',
    email: 'distribramirez@hotmail.com',
    notas: 'Polígono industrial, Benamejí (Córdoba). Agentes: Fco Ramírez Velasco / Fco Ramírez.',
  },
  sanchezGarrido: {
    nombre: 'Sánchez-Garrido e Hijos S.L.',
    telefono: '952841385',
    email: 'sandra@sanchez-garrido.com',
    notas: 'C/ Infante Don Fernando 36, Antequera (Málaga). CIF ESB93128965.',
  },
  trabuquense: {
    nombre: 'Exclusivas La Trabuquense S.L.',
    telefono: '952841385',
    email: 'sandra@sanchez-garrido.com',
    notas: 'Villanueva del Trabuco (Málaga). CIF ESB93668010. Grupo comercial vinculado a Sánchez-Garrido (mismo teléfono/email de contacto).',
  },
} as const;

type ProveedorKey = keyof typeof PROVEEDORES;

type PrecioDef = {
  proveedor: ProveedorKey;
  precioSinIva: number;
  formatoVenta: string;
  unidadMinPedido?: number;
  notas?: string;
};

type ArticuloDef = {
  nombre: string;
  categoria: string;
  formato: string;
  unidadesPorCaja?: number;
  ivaPercent?: number; // default 21
  precios: PrecioDef[];
  // Consumo neto real de la Temporada 2025 (compras − devoluciones), en la
  // unidad de compra habitual del artículo (botella/lata/barril/caja según
  // el formato — ver `formato`/`formatoVenta`).
  consumoNeto2025: number;
  observaciones?: string;
};

const ARTICULOS: ArticuloDef[] = [
  // ---- Distribuciones Francisco Ramírez Velasco SL ----
  { nombre: 'Seven Up Free lata', categoria: 'Refrescos', formato: 'Lata',
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.43, formatoVenta: 'Lata suelta' }], consumoNeto2025: 1440 },
  { nombre: 'Pepsi lata 33cl', categoria: 'Refrescos', formato: 'Lata 33cl', unidadesPorCaja: 24,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.43, formatoVenta: 'Lata suelta (caja de 24)', unidadMinPedido: 24 }], consumoNeto2025: 480 },
  { nombre: 'Tónica Schweppes lata 25cl', categoria: 'Refrescos', formato: 'Lata 25cl', unidadesPorCaja: 24,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.55, formatoVenta: 'Lata suelta (caja de 24)', unidadMinPedido: 24 }], consumoNeto2025: 1320 },
  { nombre: 'Seven Up Free 2L', categoria: 'Refrescos', formato: 'Botella 2L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.95, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 108 },
  { nombre: 'Vaso plástico Sublime 425cc', categoria: 'Menaje', formato: 'Paquete de 10 uds', unidadesPorCaja: 10,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.72, formatoVenta: 'Paquete de 10' }], consumoNeto2025: 1250 },
  { nombre: 'Fino Cobos (garrafa 15L)', categoria: 'Vino/Fino', formato: 'Garrafa 15L',
    precios: [{ proveedor: 'ramirez', precioSinIva: 28.75, formatoVenta: 'Garrafa 15L' }], consumoNeto2025: 10 },
  { nombre: 'Azul Tropical Riska 1L', categoria: 'Licores/Mezcladores', formato: 'Botella 1L',
    precios: [{ proveedor: 'ramirez', precioSinIva: 3.73, formatoVenta: 'Botella 1L' }], consumoNeto2025: 5 },
  { nombre: 'Agua Rosal 0,33L', categoria: 'Agua', formato: 'Botella 0,33L', unidadesPorCaja: 24, ivaPercent: 10,
    precios: [{ proveedor: 'ramirez', precioSinIva: 3.25, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 34 },
  { nombre: 'Tequila crema sabor mango 0,7L', categoria: 'Licores/Cremas', formato: 'Botella 0,7L',
    precios: [{ proveedor: 'ramirez', precioSinIva: 6.24, formatoVenta: 'Botella suelta' }], consumoNeto2025: 6 },
  { nombre: 'Energ Blue "Chami" 250ml', categoria: 'Energéticas', formato: 'Lata 250ml',
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.35, formatoVenta: 'Lata suelta' }], consumoNeto2025: 1104,
    observaciones: 'Nombre de marca leído del albarán manuscrito ("Chamele") — confirmar ortografía exacta al reordenar.' },
  { nombre: 'Vino Manzanilla Muy Fina 75cl', categoria: 'Vino/Fino', formato: 'Botella 75cl',
    precios: [{ proveedor: 'ramirez', precioSinIva: 3.73, formatoVenta: 'Botella suelta' }], consumoNeto2025: 6 },
  { nombre: 'Lobo Pink crema de fresa 70cl', categoria: 'Licores/Cremas', formato: 'Botella 70cl',
    precios: [{ proveedor: 'ramirez', precioSinIva: 8.82, formatoVenta: 'Botella suelta' }], consumoNeto2025: 6 },
  { nombre: 'Lobo Velvet crema piruleta 70cl', categoria: 'Licores/Cremas', formato: 'Botella 70cl',
    precios: [{ proveedor: 'ramirez', precioSinIva: 8.82, formatoVenta: 'Botella suelta' }], consumoNeto2025: 6 },
  { nombre: 'Fanta Limón lata 33cl (Fco. Ramírez)', categoria: 'Refrescos', formato: 'Lata 33cl', unidadesPorCaja: 24,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.51, formatoVenta: 'Lata suelta (caja de 24)', unidadMinPedido: 24 }], consumoNeto2025: 240,
    observaciones: 'Mismo refresco que "Fanta Limón lata 33cl (caja 24) — La Trabuquense", registrado aparte por venir en formato distinto (lata suelta vs. caja). Valorar consolidar manualmente si se concentra en un solo proveedor.' },
  { nombre: 'Coca-Cola lata 33cl (Fco. Ramírez)', categoria: 'Refrescos', formato: 'Lata 33cl', unidadesPorCaja: 24,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.58, formatoVenta: 'Lata suelta (caja de 24)', unidadMinPedido: 24 }], consumoNeto2025: 240,
    observaciones: 'Mismo refresco que las Coca-Colas de La Trabuquense, registrado aparte por venir en formato distinto (lata suelta vs. caja).' },
  { nombre: 'Royal Bliss Berry Tonic lata (Fco. Ramírez)', categoria: 'Refrescos', formato: 'Lata', unidadesPorCaja: 12,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.50, formatoVenta: 'Lata suelta (caja de 12)', unidadMinPedido: 12 }], consumoNeto2025: 480,
    observaciones: 'Mismo producto que "Royal Bliss Berry lata 25cl (caja 12) — La Trabuquense", registrado aparte por venir en formato distinto.' },
  { nombre: 'Juego 20 vasos de chupito', categoria: 'Menaje', formato: 'Bolsa de 20 uds',
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.90, formatoVenta: 'Bolsa de 20' }], consumoNeto2025: 50 },
  { nombre: 'Vaso plástico 220cc', categoria: 'Menaje', formato: 'Paquete de 30 uds', unidadesPorCaja: 30,
    precios: [{ proveedor: 'ramirez', precioSinIva: 0.50, formatoVenta: 'Paquete de 30' }], consumoNeto2025: 40 },
  { nombre: 'Lima Dama de Baza 1L', categoria: 'Licores/Mezcladores', formato: 'Botella 1L',
    precios: [{ proveedor: 'ramirez', precioSinIva: 3.25, formatoVenta: 'Botella 1L' }], consumoNeto2025: 12 },

  // ---- Sánchez-Garrido e Hijos S.L. (exclusivos) ----
  { nombre: 'Ron Barceló Añejo 0,70L', categoria: 'Ron', formato: 'Botella 0,70L', unidadesPorCaja: 12,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 13.33, formatoVenta: 'Botella suelta (caja de 12)', unidadMinPedido: 12 }], consumoNeto2025: 177 },
  { nombre: 'Ginebra Larios Rose 0,70L', categoria: 'Ginebra', formato: 'Botella 0,70L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 13.28, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 24 },
  { nombre: 'Ginebra Larios 1L', categoria: 'Ginebra', formato: 'Botella 1L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 10.81, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 55 },
  { nombre: 'Whisky DYC 8 Años 0,70L', categoria: 'Whisky', formato: 'Botella 0,70L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 11.21, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 30 },
  { nombre: 'Jägermeister 0,70L', categoria: 'Licores/Cremas', formato: 'Botella 0,70L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 11.19, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 18 },
  { nombre: 'Anís Dulce Machaquito 1L', categoria: 'Anís', formato: 'Botella 1L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 8.99, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 12 },
  { nombre: 'Ponche Caballero 1L', categoria: 'Licores/Cremas', formato: 'Botella 1L', unidadesPorCaja: 6,
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 13.54, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 }], consumoNeto2025: 5 },

  // ---- Cerveza de barril (Sánchez-Garrido) ----
  { nombre: 'Cruzcampo barril 1/3', categoria: 'Cerveza barril', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 31.67, formatoVenta: 'Barril' }], consumoNeto2025: 25 },
  { nombre: 'Heineken barril 1/3 Long Neck', categoria: 'Cerveza barril', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 38.42, formatoVenta: 'Barril' }], consumoNeto2025: 26 },
  { nombre: 'Heineken 0,0 barril 1/3', categoria: 'Cerveza barril sin alcohol', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 41.00, formatoVenta: 'Barril' }], consumoNeto2025: 4 },
  { nombre: 'El Águila barril 1/3', categoria: 'Cerveza barril', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 33.80, formatoVenta: 'Barril' }], consumoNeto2025: 2,
    observaciones: 'En 2025 los 3 barriles recibidos fueron una promoción del proveedor (100% descuento) y se devolvió 1 sin usar — el precio de lista (33,80€) es el de referencia para 2026, no lo que costó en 2025.' },
  { nombre: 'Ladrón de Verano barril 1/3', categoria: 'Cerveza barril', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 31.38, formatoVenta: 'Barril' }], consumoNeto2025: 4 },
  { nombre: 'Cruzcampo Radler Limón barril 1/3', categoria: 'Cerveza barril', formato: 'Barril 1/3',
    precios: [{ proveedor: 'sanchezGarrido', precioSinIva: 36.87, formatoVenta: 'Barril' }], consumoNeto2025: 3 },

  // ---- Mismo artículo, 2 proveedores (mismo formato — comparable directamente) ----
  { nombre: 'Johnnie Walker Etiqueta Roja 0,70L', categoria: 'Whisky', formato: 'Botella 0,70L',
    precios: [
      { proveedor: 'ramirez', precioSinIva: 10.40, formatoVenta: 'Botella suelta' },
      { proveedor: 'sanchezGarrido', precioSinIva: 11.85, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 },
    ], consumoNeto2025: 96 },
  { nombre: 'Whisky J&B 0,70L', categoria: 'Whisky', formato: 'Botella 0,70L',
    precios: [
      { proveedor: 'ramirez', precioSinIva: 9.55, formatoVenta: 'Botella suelta' },
      { proveedor: 'sanchezGarrido', precioSinIva: 10.58, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 },
    ], consumoNeto2025: 21 },
  { nombre: 'Ginebra Beefeater 0,70L', categoria: 'Ginebra', formato: 'Botella 0,70L',
    precios: [
      { proveedor: 'ramirez', precioSinIva: 11.15, formatoVenta: 'Botella suelta' },
      { proveedor: 'sanchezGarrido', precioSinIva: 13.11, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 },
    ], consumoNeto2025: 84 },
  { nombre: "Ginebra Seagram's 0,70L", categoria: 'Ginebra', formato: 'Botella 0,70L',
    precios: [
      { proveedor: 'ramirez', precioSinIva: 13.05, formatoVenta: 'Botella suelta' },
      { proveedor: 'sanchezGarrido', precioSinIva: 14.75, formatoVenta: 'Botella suelta (caja de 6)', unidadMinPedido: 6 },
    ], consumoNeto2025: 122 },
  { nombre: 'Johnnie Walker Etiqueta Roja 1L', categoria: 'Whisky', formato: 'Botella 1L',
    precios: [{ proveedor: 'ramirez', precioSinIva: 14.15, formatoVenta: 'Botella suelta' }], consumoNeto2025: 60 },

  // ---- Exclusivas La Trabuquense S.L. (exclusivos) ----
  { nombre: 'Coca-Cola lata 33cl (caja 24) — La Trabuquense', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 35.28, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 110 },
  { nombre: 'Coca-Cola Zero lata 33cl (caja 24)', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 35.28, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 80 },
  { nombre: 'Fanta Naranja lata 33cl (caja 24) — La Trabuquense', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 34.32, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 18 },
  { nombre: 'Fanta Limón lata 33cl (caja 24) — La Trabuquense', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 34.32, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 58 },
  { nombre: 'Royal Bliss Berry lata 25cl (caja 12) — La Trabuquense', categoria: 'Refrescos', formato: 'Caja 12 latas', unidadesPorCaja: 12,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 14.28, formatoVenta: 'Caja de 12', unidadMinPedido: 12 }], consumoNeto2025: 40 },
  { nombre: 'Fuze Tea lata 33cl (caja 24)', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 39.60, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 6 },
  { nombre: 'Aquarius Naranja lata 33cl (caja 24)', categoria: 'Refrescos', formato: 'Caja 24 latas', unidadesPorCaja: 24,
    precios: [{ proveedor: 'trabuquense', precioSinIva: 37.44, formatoVenta: 'Caja de 24', unidadMinPedido: 24 }], consumoNeto2025: 6 },
];

// No se registran en el histórico (por decisión explícita al revisar los
// datos): envases/fianzas retornables (no son consumo), "Cruzcampo Sin
// Gluten 1/3" (solo hay nota de devolución, sin factura de compra de
// referencia — falta al menos un albarán de Sánchez-Garrido anterior al
// 24/09/2025 que no está disponible), y el regalo promocional "Tira 67
// vasos Cruzcampo" (coste 0, no es una compra real).

async function findOrCreateTemporada(anio: number, nombre: string, status: 'ABIERTA' | 'CERRADA') {
  const existing = await prisma.temporada.findFirst({ where: { anio } });
  if (existing) return existing;
  return prisma.temporada.create({ data: { anio, nombre, status } });
}

async function findOrCreateProveedor(nombre: string, data: { telefono?: string; email?: string; notas?: string }) {
  const existing = await prisma.proveedor.findFirst({ where: { nombre } });
  if (existing) return existing;
  return prisma.proveedor.create({ data: { nombre, ...data } });
}

async function findOrCreateArticulo(nombre: string, data: { categoria: string; formato: string; unidadesPorCaja: number; ivaPercent: number }) {
  const existing = await prisma.articulo.findFirst({ where: { nombre } });
  if (existing) return existing;
  return prisma.articulo.create({ data: { nombre, ...data } });
}

function precioConIva(precioSinIva: number, ivaPercent: number): number {
  return precioSinIva * (1 + ivaPercent / 100);
}

async function main() {
  const temporadaHistorica = await findOrCreateTemporada(TEMPORADA_HISTORICA.anio, TEMPORADA_HISTORICA.nombre, 'CERRADA');
  const temporadaActual = await findOrCreateTemporada(TEMPORADA_ACTUAL.anio, TEMPORADA_ACTUAL.nombre, 'ABIERTA');

  const proveedorIds: Record<ProveedorKey, string> = {} as Record<ProveedorKey, string>;
  for (const key of Object.keys(PROVEEDORES) as ProveedorKey[]) {
    const def = PROVEEDORES[key];
    const proveedor = await findOrCreateProveedor(def.nombre, { telefono: def.telefono, email: def.email, notas: def.notas });
    proveedorIds[key] = proveedor.id;
  }

  let costeEstimadoTotal = 0;
  let planesNuevos = 0;
  let planesExistentes = 0;

  for (const art of ARTICULOS) {
    const ivaPercent = art.ivaPercent ?? 21;
    const articulo = await findOrCreateArticulo(art.nombre, {
      categoria: art.categoria,
      formato: art.formato,
      unidadesPorCaja: art.unidadesPorCaja ?? 1,
      ivaPercent,
    });

    let precioMasBarato = Infinity;
    for (const p of art.precios) {
      const proveedorId = proveedorIds[p.proveedor];
      await prisma.precioArticulo.upsert({
        where: { articuloId_proveedorId: { articuloId: articulo.id, proveedorId } },
        update: { precioSinIva: p.precioSinIva, formatoVenta: p.formatoVenta, unidadMinPedido: p.unidadMinPedido ?? 1, notas: p.notas },
        create: {
          articuloId: articulo.id,
          proveedorId,
          precioSinIva: p.precioSinIva,
          formatoVenta: p.formatoVenta,
          unidadMinPedido: p.unidadMinPedido ?? 1,
          notas: p.notas,
        },
      });
      precioMasBarato = Math.min(precioMasBarato, precioConIva(p.precioSinIva, ivaPercent));
    }

    await prisma.consumoHistorico.upsert({
      where: { articuloId_temporadaId: { articuloId: articulo.id, temporadaId: temporadaHistorica.id } },
      update: { cantidadNeta: art.consumoNeto2025, fuenteDatos: 'Facturas/albaranes de proveedor 2025 (neto de devoluciones)' },
      create: {
        articuloId: articulo.id,
        temporadaId: temporadaHistorica.id,
        cantidadNeta: art.consumoNeto2025,
        fuenteDatos: 'Facturas/albaranes de proveedor 2025 (neto de devoluciones)',
      },
    });

    const planExistente = await prisma.planCompra.findUnique({
      where: { temporadaId_articuloId: { temporadaId: temporadaActual.id, articuloId: articulo.id } },
    });
    if (planExistente) {
      planesExistentes += 1;
    } else {
      planesNuevos += 1;
      await prisma.planCompra.create({
        data: {
          temporadaId: temporadaActual.id,
          articuloId: articulo.id,
          cantidadPlanificada: art.consumoNeto2025,
          observaciones:
            art.observaciones ??
            'Propuesta inicial = consumo neto de 2025 (única temporada de referencia disponible). Ajustar según previsión de asistencia de este año.',
        },
      });
    }

    costeEstimadoTotal += precioMasBarato * art.consumoNeto2025;
  }

  console.log(`Temporada histórica: ${temporadaHistorica.nombre} (${temporadaHistorica.id})`);
  console.log(`Temporada actual:    ${temporadaActual.nombre} (${temporadaActual.id})`);
  console.log(`Artículos procesados: ${ARTICULOS.length}`);
  console.log(`Planes de compra creados: ${planesNuevos} | ya existentes (no tocados): ${planesExistentes}`);
  console.log(`Coste estimado si se repite el consumo de 2025 al proveedor más barato de cada artículo: ${costeEstimadoTotal.toFixed(2)} € (con IVA)`);
  console.log('Revisa y ajusta las cantidades en /admin/compras/planificador con la Temporada actual seleccionada.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
