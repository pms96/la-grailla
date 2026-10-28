# Ficha de alta de un cliente nuevo

Se rellena **con el cliente, antes de tocar el panel**. Los pasos dentro del panel están en [`m9-primer-despliegue.md`](./m9-primer-despliegue.md), sección E; esta ficha reúne lo que hay que pedir para que esos pasos salgan a la primera.

> Ningún secreto (claves de pago, URLs de bases de datos, contraseñas) se manda por chat ni por correo. Cada uno se pega directamente en el sitio que se indica.

## 1. Datos básicos

- [ ] **Nombre del cliente** (como se verá en el panel y en los avisos): ______
- [ ] **Dominio de la web** (p. ej. `www.cliente.es`): ______ · ¿Quién puede crear registros DNS? ______
- [ ] **Correo de avisos** (recibe los mensajes del formulario de contacto y los avisos): ______
- [ ] **Persona administradora de la web** (nombre y correo; recibe una invitación y fija ella su contraseña): ______

## 2. Qué contrata

El **núcleo** va siempre: web con formulario de contacto, apariencia, usuarios, configuración y bandeja de mensajes.

- [ ] Tienda online
- [ ] Venta de entradas
- [ ] Contabilidad
- [ ] Wallets (suplemento mensual; exige Entradas o Tienda)
- [ ] Sponsors

**Licencia:** pagado hasta ______ · plazos de aviso y bloqueo si no se paga (por defecto 7 días de gracia, 15 con el panel bloqueado y bloqueo total a los 22): ______

## 3. Cobros

El dinero va **a la cuenta del propio cliente**. Pasarela: [ ] SumUp · [ ] Stripe · [ ] ninguna por ahora.

| Pasarela | Qué necesita el cliente | Cómo funciona |
|---|---|---|
| SumUp | Clave de API y código de comerciante | Sin webhook: el pedido se confirma cuando el comprador vuelve a la web, y una tarea cada 5 minutos recoge los que no vuelven. |
| Stripe | Clave secreta y secreto del webhook; dar de alta en su Stripe el endpoint `https://<dominio>/api/webhooks/stripe` | Webhook de confirmación. **El camino de Stripe con varios clientes no se ha probado con dinero real**: la compra de prueba del apartado 8 es obligatoria. |

Las claves las pega el propio administrador del cliente en el admin de su web (Configuración). **No** se meten en el panel del proveedor.

**Comprobación anti-bots (recomendada antes de abrir ventas con demanda):** el cliente crea un widget gratuito de Cloudflare Turnstile para SU dominio y pega las dos claves en Configuración → General. Detalle y límites en [`captcha.md`](captcha.md).

## 4. Cómo se ve

- [ ] **Plantilla:** `feria` (oscura, degradados, pegatinas de borde grueso) o `editorial` (sobria, mucho aire, titular grande)
- [ ] **Logo** en versión clara y oscura, y favicon
- [ ] **Color principal** y, si lo tiene, secundario: ______
- [ ] **Tipografías** (se elige una pareja del catálogo cerrado): ______
- [ ] **Modo por defecto:** claro / oscuro
- [ ] **Textos de marca** (nombre, lema, descripción): ______

La web se ve bien sin nada de esto (plantilla neutra con su dominio como nombre); lo de arriba es para dejarla suya. Se retoca después en **Apariencia**, con vista previa.

## 5. Textos legales (obligatorios: sin ellos no se publica)

- [ ] Aviso legal
- [ ] Política de privacidad
- [ ] Política de cookies

Los redacta el cliente (o su abogado). El proveedor no los inventa.

## 6. Datos previos

- [ ] Empieza de cero
- [ ] Trae datos de una web anterior (eventos, pedidos, usuarios): se estima **aparte**, es una migración a medida.

## 7. Infraestructura y contrato (lado proveedor)

- [ ] **Neon:** un proyecto propio para este cliente, región de la UE. El plan gratuito solo sirve para pruebas; con dinero real conviene uno de pago con restauración a varios días. Se copian las dos URLs (pooled y directa, con `sslmode=require`) y se pegan en el panel.
- [ ] **DPA firmado:** el cliente es responsable del tratamiento y el proveedor, encargado. Lista de subencargados vigente: Vercel, Neon, Upstash, Vercel Blob y el servicio de correo del panel (si se usa).
- [ ] **Copias de seguridad:** quién y con qué frecuencia (`scripts/backup-db.sh`, ver m9 sección F).
- [ ] **Correo saliente de la web del cliente** (confirmaciones de compra, respuestas a mensajes): el propio cliente configura el suyo en Configuración → Email.

## 8. Checklist de alta

1. [ ] Proyecto de Neon creado y URLs copiadas
2. [ ] Asistente de alta en el panel (`/tenants/new`) con los apartados 1, 2, 5 y 7
3. [ ] Registro DNS creado y dominio verificado; dominio añadido en Vercel
4. [ ] Invitación enviada; el administrador fija su contraseña y entra
5. [ ] El administrador completa Configuración (pagos, correo, redes sociales y, si habrá venta con demanda, las claves de Turnstile)
6. [ ] Apariencia (apartado 4)
7. [ ] **Comprobar salud** en el panel: «Sirviendo al cliente: sí»
8. [ ] **Compra de prueba de importe mínimo y su reembolso**, antes de abrir ventas
9. [ ] Vigilante externo apuntando a `https://<dominio>/api/health`
10. [ ] Fecha de alta y de vencimiento de licencia anotadas
