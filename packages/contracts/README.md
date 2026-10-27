# @grailla/contracts

Contrato entre el panel de control (que escribe) y el front (que lee). Todo lo que cruza esa frontera se valida aquí.

- `RoutingRecord`: lo que el front necesita para resolver un Host. **Sin secretos** (las URLs de BD van en otro registro, solo Node).
- `SnapshotEnvelope`: el registro firmado con Ed25519 (`kid`, `seq`, `iat`, `staleUntil`, `contractVersion`).
- `newUlid`/`isUlid`: identidad de tenant, inmutable.
- `normalizeHost`: la única forma de comparar dominios.
- `OpsBlockSchema` / `parseOpsBlock`: el bloque `ops` (señales de negocio, sin datos personales) de `GET /api/health`. Lo produce el front y lo lee el panel; es **opcional** en la respuesta y los campos que no conoce se ignoran (aditivo, no sube `CONTRACT_VERSION`).

## Reglas de compatibilidad

- Cambios **aditivos** (campo opcional nuevo): misma `CONTRACT_VERSION`. El lector ignora campos desconocidos.
- Cambios que rompen: se sube `CONTRACT_VERSION`. Un front que no la soporta rechaza el snapshot (`unsupported_contract`) y sigue con el último válido; nunca interpreta a ciegas.
- Módulos desconocidos se ignoran (deny). Una fase de licencia desconocida invalida el registro entero.
- `verifySnapshot` exige el `host` de la petición (el snapshot debe listar ese dominio) y, si se indica, el `product`. Sin ello una firma válida de un cliente serviría bajo el dominio de otro.
- `seq` es por suscripción (tenant × producto), no por host. El lector rechaza uno menor que el último visto para esa suscripción (hoy en la memoria de la instancia; ver `docs/platform/m5-modulos-licencia.md` sobre por qué no se persiste en el mismo almacén).
- `license.schedule` (opcional) lista los cambios de fase futuros; el lector solo los aplica con una lectura fresca de un snapshot no obsoleto, y nunca mejora la fase por sí solo.
- `revoked:{tenantId}` en el almacén (`registryKeyForRevocation`) es la revocación de emergencia: su presencia corta al cliente.
- `staleUntil` no invalida: un panel caído no debe apagar las webs. Un snapshot obsoleto solo se marca (`stale`); el corte de emergencia va por la clave de revocación del almacén y por rotar el `kid`.
- La firma cubre `grailla-snapshot-v1\n{kid}\n{payload}`: el payload es el texto exacto que se firmó; no hay canonicalización de JSON.

Sin dependencias propias: `zod` es peer del front. Para convertirlo en workspace de npm basta con declarar `workspaces` en el `package.json` raíz (se deja para M3, cuando exista `apps/control-panel` y merezca tocar los dos lockfiles).
