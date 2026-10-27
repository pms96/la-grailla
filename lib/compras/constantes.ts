export const CATEGORIAS_ARTICULO = [
  'Refrescos',
  'Cervezas',
  'Espirituosos',
  'Aguas',
  'Vinos',
  'Otros',
] as const;

export const CATEGORIAS_GASTO = [
  'Bebidas y bar',
  'Personal',
  'Alquiler de puesto',
  'Electricidad y suministros',
  'Licencias y permisos',
  'Transporte',
  'Decoración',
  'Hielo y perecederos',
  'Otros',
] as const;

export const TIPOS_DOCUMENTO_GASTO = ['Factura', 'Abono', 'Otro'] as const;

export const CONCEPTOS_INGRESO = ['Entradas', 'Barra', 'Comida', 'Merchandising', 'Otros'] as const;

export const PEDIDO_STATUS_LABEL: Record<string, string> = {
  BORRADOR: 'Borrador',
  ENVIADO: 'Enviado',
  RECIBIDO: 'Recibido',
};

/** Nombre con el que se propone la primera temporada: el de La Grailla («Feria de Septiembre»), que es su vertical; el resto de clientes, uno neutro. */
export function nombreTemporadaPorDefecto(legacy: boolean, anio: number = new Date().getFullYear()): string {
  return legacy ? `Feria de Septiembre ${anio}` : `Temporada ${anio}`;
}

/** Descripción bajo el título de cada pantalla de Contabilidad: las de La Grailla hablan de su caseta; el resto de clientes, de lo suyo sin vertical. */
export function descripcionContabilidad(seccion: 'compras' | 'gastos' | 'ingresos', legacy: boolean): string {
  const textos = {
    compras: ['Catálogo, comparativa de precios y pedidos de la caseta', 'Catálogo, comparativa de precios y pedidos a proveedores'],
    gastos: ['Contabilidad real de la caseta por temporada', 'Contabilidad real por temporada'],
    ingresos: ['Caja física de la caseta, día a día, por temporada', 'Caja física, día a día, por temporada'],
  } as const;
  return textos[seccion][legacy ? 0 : 1];
}
