# Comprobación anti-bots (Cloudflare Turnstile)

Frena a los scripts que reservan entradas o stock sin pagar (auditoría EN-06 / TI-14). Complementa los topes por IP y por pedidos pendientes, que un script con muchas IP o con IPv6 esquiva. **No es una defensa completa**: no frena a una persona que paga o a un servicio de resolución de captchas, ni sustituye los límites por email, el aforo y la sala de espera.

## Qué protege

| Punto | Cuándo se pide | Acción del token |
|---|---|---|
| `POST /api/queue/join` | Solo al **crear un turno nuevo**: quien ya tiene un turno vivo y lo consulta no lo ve nunca; quien vuelve con un turno `EXPIRED` sí, porque se le crea uno nuevo | `queue` |
| `POST /api/orders` | Pedido de entradas **sin sala de espera**. Con sala de espera, el turno ADMITIDO ya demuestra que pasó el captcha y no se pide otro. Si el admin apaga la cola a media venta, el servidor pasa a exigirlo, por eso el formulario lleva el widget siempre | `order` |
| `POST /api/shop/orders` | Pedido de la tienda | `shop-order` |

Un token vale **una vez** y caduca a los ~5 min. Va ligado a su acción solo como higiene (evita mezclar tokens por error): **no es una barrera contra un atacante**, que puede montar su propio widget con la clave pública y la acción que quiera. El tope por IP en la cola se comprueba **antes** de gastar el token. Un reintento idempotente de un pedido que ya existe no pide otro. **El formulario de contacto no lleva captcha** (ya tiene honeypot, topes por IP y tope global).

## Cómo se activa (por cliente)

1. El cliente entra en Cloudflare → Turnstile → *Add widget*, pone el dominio de su web y elige modo **Managed**.
2. Pega la **clave del sitio** y la **clave secreta** en *Configuración → General → Comprobación anti-bots*.
3. Con **las dos** puestas se activa; con una sola, o ninguna, queda desactivado y todo funciona como antes (no se carga ningún script de Cloudflare).

La clave secreta se guarda cifrada (como las de la pasarela) y no se vuelve a mostrar. Las claves de **un cliente no sirven en otro**: cada dominio, su widget.

## Cómo se comporta

- **Modo `interaction-only`**: el comprador casi nunca ve nada; Cloudflare solo muestra un reto si desconfía. En la sala de espera aparece la pantalla «Una comprobación rápida» mientras se resuelve.
- **Falla ABIERTO ante problemas nuestros o de Cloudflare** (Cloudflare no responde en 4 s, error 5xx, `internal-error`, o la clave secreta no es válida): la compra **sigue**, se deja constancia en el log y se avisa a Sentry (como mucho una vez cada 10 min por instancia, motivo `captcha_unavailable`). Un captcha caído no puede cerrar la venta.
- **Falla CERRADO ante token ausente, caducado, repetido o inválido**: 400 con `code` `captcha_required` / `captcha_failed`.
- Si el script de Cloudflare no carga (bloqueador de anuncios, Cloudflare caído) o el widget da error (dominio no incluido en el widget, clave mal pegada), la pantalla lo dice, ofrece reintentar y el navegador **envía igualmente sin token**: si Cloudflare está caído el servidor deja pasar; si solo está bloqueado en ese navegador, el servidor lo rechaza con «Completa la comprobación…» y esa persona no puede comprar hasta que el script cargue.
- **La clave secreta mal puesta deja el captcha apagado** (por diseño falla abierto) y solo avisa a Sentry, como mucho una vez cada 10 min por cliente. Falta un botón «probar claves» como el de la pasarela: tras pegar las claves, hacer una compra de prueba.
- Un fallo de lectura de la configuración en la BD también deja pasar, pero se avisa (no se apaga en silencio).
- Un turno ADMITIDO sirve para varios pedidos si se lanzan a la vez (el límite lo ponen los topes de pedidos pendientes por IP); el captcha protege la **entrada** en la cola, no cada pedido.

## Qué hay que saber antes de venderlo

- **Subencargado y RGPD**: Cloudflare recibe datos técnicos del navegador del comprador. Ver `marco-legal.md` §2: decidir con el abogado si se menciona en la privacidad y en el DPA.
- **CSP**: `next.config.js` permite `https://challenges.cloudflare.com` en `script-src`, `frame-src` y `connect-src`, para todos los clientes aunque no lo usen.
- **Páginas cacheadas**: la clave pública llega por la página de compra, que es dinámica (no pasa por la caché del CDN). Si el cliente cambia las claves, aplica al instante.
- **No probado contra Cloudflare real con claves de un cliente**: sí con las claves de prueba públicas de Cloudflare (`1x00000000000000000000AA`, siempre pasa) en local. Hacer una compra de prueba con las claves reales antes de abrir ventas, y comprobar en el panel de Cloudflare que el dominio está en la lista del widget.
- **Accesibilidad**: Turnstile cumple WCAG 2.1 AA según Cloudflare, pero no se ha auditado dentro de esta web.
- **Sin captcha en taquilla ni admin** (personal autenticado).
