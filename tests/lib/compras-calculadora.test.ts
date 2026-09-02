import { describe, it, expect } from 'vitest';
import {
  precioConIva,
  precioTrasDescuento,
  precioFinalUnidad,
  proveedorRecomendado,
  ahorroFrenteAlMasCaro,
  porcentajeAhorro,
  type PrecioComparado,
} from '@/lib/compras/calculadora';

describe('precioConIva', () => {
  it('aplica el IVA y redondea a 2 decimales', () => {
    expect(precioConIva(0.59, 21)).toBe(0.71);
    expect(precioConIva(10, 21)).toBe(12.1);
  });

  it('soporta el IVA reducido del agua (10%)', () => {
    expect(precioConIva(0.72, 10)).toBe(0.79);
  });
});

describe('precioTrasDescuento', () => {
  it('no cambia el precio sin descuento', () => {
    expect(precioTrasDescuento(10, 0)).toBe(10);
  });

  it('resta el porcentaje de descuento', () => {
    expect(precioTrasDescuento(10, 15)).toBe(8.5);
  });
});

describe('precioFinalUnidad', () => {
  it('coincide con precioConIva cuando no hay descuento', () => {
    expect(precioFinalUnidad(0.6, 0, 21)).toBe(precioConIva(0.6, 21));
  });

  it('aplica el descuento antes del IVA', () => {
    // 0.6€ -10% = 0.54€ sin IVA -> 0.54 * 1.21 = 0.6534 -> 0.65€
    expect(precioFinalUnidad(0.6, 10, 21)).toBe(0.65);
  });
});

describe('proveedorRecomendado', () => {
  const precio = (proveedorId: string, precioConIva: number): PrecioComparado => ({
    proveedorId,
    proveedorNombre: proveedorId,
    precioSinIva: precioConIva,
    precioConIva,
  });

  it('devuelve null sin proveedores con precio', () => {
    expect(proveedorRecomendado([])).toBeNull();
  });

  it('devuelve el único proveedor disponible', () => {
    expect(proveedorRecomendado([precio('ramirez', 5)])?.proveedorId).toBe('ramirez');
  });

  it('recomienda el más barato entre N proveedores', () => {
    const precios = [precio('ramirez', 16.82), precio('javi', 12.48), precio('otro', 20)];
    expect(proveedorRecomendado(precios)?.proveedorId).toBe('javi');
  });
});

describe('ahorroFrenteAlMasCaro', () => {
  const precio = (id: string, precioConIva: number): PrecioComparado => ({ proveedorId: id, proveedorNombre: id, precioSinIva: precioConIva, precioConIva });

  it('es 0 sin proveedores', () => {
    expect(ahorroFrenteAlMasCaro([])).toBe(0);
  });

  it('es 0 con un solo proveedor (nada que comparar)', () => {
    expect(ahorroFrenteAlMasCaro([precio('ramirez', 10)])).toBe(0);
  });

  it('calcula la diferencia entre el más caro y el más barato con N proveedores', () => {
    const precios = [precio('ramirez', 16.82), precio('javi', 12.48), precio('otro', 20)];
    expect(ahorroFrenteAlMasCaro(precios)).toBeCloseTo(7.52, 2);
  });
});

describe('porcentajeAhorro', () => {
  it('calcula el % de ahorro frente al precio más caro', () => {
    expect(porcentajeAhorro(12.48, 16.82)).toBeCloseTo(25.8, 1);
  });

  it('es 0 si el precio más caro es 0 (sin datos)', () => {
    expect(porcentajeAhorro(0, 0)).toBe(0);
  });
});
