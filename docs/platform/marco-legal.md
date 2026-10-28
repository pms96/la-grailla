# Marco legal de la venta (P0-11)

> Lo que el código sostiene y lo que **no** decide. Es la hoja para el abogado y la gestoría. Nada de lo que hay aquí es asesoramiento jurídico ni fiscal: las exigencias concretas las confirma quien revisa los textos.

## 1. Qué hace ahora la plataforma

| Tema | Qué hace | Dónde |
|---|---|---|
| **No es factura** | Lo que recibe el comprador (pantalla de confirmación, recibo de la tienda, correo) se llama **«Justificante de compra»** y dice expresamente que **no es una factura**, con el correo del cliente al que pedirla. | `lib/fiscal.ts`, `components/fiscal-footnote.tsx`, `lib/fiscal-email.ts` |
| **Vendedor** | Razón social, NIF y domicilio fiscal, editables en Configuración → Legal. **Sin NIF no se imprime ningún dato del vendedor** (no se inventa nada). | `fiscal_legal_name`, `fiscal_nif`, `fiscal_address` |
| **IVA** | Un tipo por módulo (`vat_rate_entradas`, `vat_rate_tienda`), vacío = no configurado (no se desglosa nada). Con tipo: «IVA incluido (X %) · base · cuota». Se copia al pedido al crearlo (`vatRate`): cambiarlo después no reescribe justificantes anteriores. `0` es un tipo válido. | `Order.vatRate`, `ShopOrder.vatRate` |
| **Aceptación de condiciones** | Casilla obligatoria («He leído y acepto las condiciones de venta y la política de privacidad», con enlaces). **El servidor la exige** (`acceptedTerms === true`): llamar a la API a mano sin ella da 400. | `components/legal-acceptance.tsx`, `app/api/orders`, `app/api/shop/orders` |
| **Prueba de qué se aceptó** | El pedido guarda cuándo aceptó (`termsAcceptedAt`) y la **versión** (`termsVersion` = hash de los textos que veía). Una copia inmutable de esos textos queda en `LegalSnapshot`: se puede demostrar qué aceptó aunque el cliente cambie luego sus condiciones. | `lib/legal-terms.ts`, tabla `LegalSnapshot` |
| **Aviso de edad** | Si el evento tiene aviso de edad, hay una segunda casilla y **el servidor la exige** (entrando directo a `/comprar` ya no se salta). Se guarda `ageConfirmedAt`. | `Order.ageConfirmedAt` |
| **Condiciones de venta** | Dos páginas públicas editables: `/legal/condiciones-entradas` y `/legal/condiciones-tienda`, enlazadas en el pie y en el checkout. Solo existen si el módulo está activo. | `legal_terms_entradas`, `legal_terms_tienda` |
| **«IVA incluido»** | «Precios con IVA incluido.» en el checkout cuando el cliente configuró un tipo mayor que 0. | |

## 2. Lo que NO hace (a propósito)

- **No emite facturas**: no hay serie, numeración correlativa, factura simplificada, rectificativas ni Verifactu/TicketBAI. Construirlo convierte a la plataforma en «sistema informático de facturación» (certificación, declaración responsable, calendario de obligaciones). **Recomendación:** integrar un facturador certificado (o apoyarse en la gestoría) cuando haya demanda real; el justificante ya dice cómo pedirla.
- **Un solo tipo de IVA por módulo.** Por entrada o por producto (0/4/10/21 + exento con motivo) llega con el facturador (fase 2): requiere precio e IVA por línea.
- **El IVA se calcula sobre el total cobrado**, incluidos los «gastos de distribución» (comisión) en entradas. Si la comisión tributa de forma distinta (otro tipo, o es un servicio aparte), el desglose del justificante no es el correcto: **confirmar con la gestoría**.
- **No hay gastos de envío** en la tienda (el total es el de los productos). Si se cobran, hay que añadirlos al total y a las condiciones.
- **No guarda NIF ni datos fiscales del comprador.**
- **Taquilla (venta en persona)**: no registra aceptación de condiciones ni IVA (no hay checkout online).
- **Marketing**: no hay casilla de consentimiento de marketing (no se envía marketing).
- **Captcha (Cloudflare Turnstile), opcional por cliente**: si el cliente lo activa, el navegador del comprador carga un script de Cloudflare y le envía datos técnicos para decidir si es una persona (Cloudflare declara que no usa cookies de seguimiento ni lo usa para publicidad). Es un **subencargado más**: el abogado debe decidir si hace falta mencionarlo en la política de privacidad y en el DPA del cliente (ver [`captcha.md`](captcha.md)). El texto de privacidad por defecto **no** lo menciona.
- **Pedidos anteriores a este cambio** no tienen aceptación registrada (`termsAcceptedAt` nulo).

## 3. Textos por defecto — pendientes de revisión del abogado

Si el cliente no escribe sus condiciones, se muestra un **borrador orientativo** (`lib/legal-defaults.ts`). Hay que revisarlo para la actividad de cada cliente antes de vender. Puntos concretos:

1. **Entradas: exclusión del desistimiento** (art. 103.l del texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios: actividades de ocio con fecha o periodo específicos). ¿Aplica a todos los eventos de los clientes (conciertos, discotecas, ferias)?
2. **Entradas: cancelación y aplazamiento.** El borrador promete devolución si se cancela y devolución «según el aviso» si se aplaza. ¿Política correcta?
3. **Tienda: desistimiento de 14 días**, reembolso en 14 días, coste de devolución del comprador, excepción para productos personalizados o confeccionados, entrega máxima de 30 días y garantía legal. La tienda hoy vende «merch bajo pedido»: ¿es producto confeccionado/personalizado (excepción) o no?
4. **Garantía** (texto genérico «garantía legal de conformidad»): ¿conviene citar los 3 años?
5. **Hojas de reclamaciones** y datos de contacto del titular: el borrador menciona hojas de reclamaciones; ¿obligatorio indicarlo así?
6. **Privacidad**: la política es texto libre del cliente (`privacy_policy`); la casilla enlaza a ella. Revisar que cubra el tratamiento de pedidos (comprador, email, pagos, envíos) y a los encargados (pasarela de pago, correo).
7. **Edad**: el aviso de edad se registra como confirmación del comprador. Menores de 16–17 con autorización: sigue siendo una plantilla en PDF sin verificación.

## 4. Para la gestoría

- ¿Tipo de IVA aplicable a las entradas y a la tienda de cada cliente (espectáculo cultural, baile/discoteca, merchandising)?
- ¿Puede el justificante servir como factura simplificada y con qué contenido mínimo? (hoy NO lo es y lo dice).
- Obligaciones Verifactu/TicketBAI según el territorio y su calendario vigente, si el cliente emite facturas por otro medio.
- IVA de los gastos de distribución.
- OSS si la tienda vende a otros Estados de la UE.

## 5. Puesta en marcha por cliente

1. **Configuración → Legal:** razón social, NIF, domicilio fiscal, y sus **condiciones de venta** (entradas y/o tienda). Revisarlas con el asesor.
2. **Configuración → Entradas / Tienda:** tipo de IVA (el de la gestoría) si quiere el desglose.
3. Probar una compra con la pasarela en modo prueba: comprobar la casilla, el justificante en pantalla y el correo.

## 6. Despliegue

- **Migración aditiva** `20261027140000_legal_acceptance` (columnas nulables en `Order` y `ShopOrder` + tabla `LegalSnapshot`). `FRONT_MIN_SCHEMA` sube a ella: **antes de desplegar el front, «Migrar BD» en cada cliente** (un cliente sin migrar queda en mantenimiento hasta que se migre; el front viejo funciona con la BD nueva, así que migrar primero no rompe nada).
- Ventas en curso durante el despliegue: un navegador con el formulario antiguo abierto no manda la aceptación y recibirá un 400 con el mensaje «Debes aceptar las condiciones…»; basta recargar la página.
