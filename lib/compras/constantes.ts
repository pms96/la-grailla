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

export const PEDIDO_STATUS_LABEL: Record<string, string> = {
  BORRADOR: 'Borrador',
  ENVIADO: 'Enviado',
  RECIBIDO: 'Recibido',
};
