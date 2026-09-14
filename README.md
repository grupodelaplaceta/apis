# Banco Placeta Secure API

API privada para que la app guarde el estado bancario en MongoDB Atlas sin exponer la URI de Mongo en Android.

URL base de produccion: `https://api.banco.laplaceta.org`

## Deploy en Vercel

1. Crea un proyecto en Vercel apuntando a esta carpeta: `vercel-bank-api`.
2. Añade variables de entorno:
   - `MONGODB_URI`
   - `MONGODB_DB`
   - `MONGODB_STATE_COLLECTION`
   - `MONGODB_NONCE_COLLECTION`
   - `PLACETA_APP_ID` o `PLACETA_APP_IDS` separado por comas
   - `PLACETA_APP_SECRET` o `PLACETA_API_SECRET` (`PLACETA_APP_SECRETS` permite varios separados por comas)
   - `PLACETA_ID_JWT_SECRET` o `JWT_SECRET` con el mismo secreto JWT que PlacetaID para aceptar tokens Bearer de la app movil
   - `ALLOWED_ORIGINS` opcional, separado por comas
   - `CRM_READ_KEY`: clave compartida para el endpoint `crm-state` (lectura de estado y transferencias normales). Se envía en la cabecera `X-CRM-Key`.
   - `BANK_EMISSION_KEY`: clave **dedicada** para emitir/quemar PLACETAS (solo administradores del RSP). Se envía en la cabecera `x-emission-key`. **Si no se configura, la emisión queda deshabilitada** (fail-closed).
3. Deploy:

```bash
vercel --prod
```

## Endpoints

- `GET https://api.banco.laplaceta.org/api/state`: devuelve el documento de estado.
- `PUT https://api.banco.laplaceta.org/api/state`: recibe el estado completo y lo reparte en colecciones Mongo.
- `GET https://api.banco.laplaceta.org/api/entity?collection=accounts`: lee una colección concreta.
- `PUT https://api.banco.laplaceta.org/api/entity?collection=accounts&id=u-alba`: upsert de una entidad.
- `DELETE https://api.banco.laplaceta.org/api/entity?collection=accounts&id=u-alba`: borra una entidad.
- `GET https://api.banco.laplaceta.org/api/health`: ping protegido.

Endpoints ciudadanos (`/api/web/*`, Bearer PlacetaID):

- `GET /api/web/cuenta` · `GET /api/web/movimientos` · `GET /api/web/tarjetas` · `GET /api/web/gestores` · `GET /api/web/cumplimiento` · `GET /api/web/contactos`
- `POST /api/web/transferencia` (crea operación pendiente)
- `GET /api/web/registro`: consulta previa. Devuelve si el DIP del titular ya existe en el banco y qué cuentas tiene.
- `POST /api/web/registro`: **alta por DIP de PlacetaID** (ver abajo).

## Alta por DIP de PlacetaID (`/api/web/registro`)

Cualquier DIP válido de PlacetaID (DNI `12345678Z` o NIE `X1234567L`) puede darse
de alta en el banco por sí mismo: solo hace falta el Bearer de su sesión de
PlacetaID. El DIP se toma **siempre del token**, nunca del cuerpo de la petición.

Antes de crear nada, el servidor **busca por el DIP** en el estado real
(`bank_users` + `bank_accounts` + `bank_account_holders`) comparando por
identidad canónica, de modo que `12345678Z`, `PLID-12345678Z` y `DIP-12345678Z`
son la misma persona. Resultado:

| Caso | Qué hace |
| --- | --- |
| Ya tiene cuentas y usuario | Nada (idempotente). Devuelve sus cuentas. |
| Tiene cuentas pero **no** `bank_user` (titulares migrados) | Crea el `bank_user` y lo vincula a su cuenta existente. **No duplica cuentas.** |
| Tiene `bank_user` pero le falta la cuenta | Abre la cuenta que falte y la marca como principal. |
| No tiene nada (adulto) | Abre cuenta corriente ciudadana `GDLP-AP##-###`, saldo 0. |
| No tiene nada (menor de 18) | Registra su identidad; la cuenta la abre un tutor legal (`requiereTutor: true`). |

Respuestas: `200` (vinculado / ya existía), `201` (cuenta abierta), `400`
`dip_invalido`. Todas las altas quedan auditadas en `bank_audit_logs` con
`action: "registro_placetaid"`.

```bash
# Consulta previa
curl -H "Authorization: Bearer $TOKEN" https://api.banco.laplaceta.org/api/web/registro
# Alta
curl -X POST -H "Authorization: Bearer $TOKEN" https://api.banco.laplaceta.org/api/web/registro
```

Pruebas locales de la lógica (sin Mongo): `npm test` (reconciliación + registro).

Todos los endpoints requieren una de estas dos autenticaciones:

- Firma HMAC para llamadas servidor-a-servidor.
- `Authorization: Bearer {tokenSesion}` emitido por PlacetaID para la app movil.

## Firma requerida

Headers:

- `x-placeta-app-id`
- `x-placeta-timestamp`
- `x-placeta-nonce`
- `x-placeta-signature`

Payload firmado:

```text
METHOD
/api/state
TIMESTAMP
NONCE
SHA256_HEX_BODY
```

Firma:

```text
hex(HMAC_SHA256(PLACETA_APP_SECRET o PLACETA_API_SECRET, payload))
```

El servidor rechaza:

- App ID incorrecto.
- Timestamp con más de 5 minutos.
- Nonce repetido.
- Firma inválida.
- Body mayor a 20 MB.

## Token PlacetaID para clientes moviles

La app Android no debe compilar `PLACETA_API_SECRET`. En release envia:

- `x-placeta-app-id`
- `Authorization: Bearer {tokenSesion}`

La API valida el JWT con `PLACETA_ID_JWT_SECRET`, `PLACETA_ID_JWT_SECRETS` o `JWT_SECRET`.

## Colecciones Mongo usadas

- `bank_meta`
- `bank_users`
- `bank_accounts`
- `bank_transactions`
- `bank_subsidy_requests`
- `bank_investment_holdings`
- `bank_digital_cards`
- `bank_saved_contacts`
- `bank_promo_slides`
- `bank_compliance_flags`
- `bank_treasury_config`

`/api/state` existe solo como compatibilidad para la app: reconstruye el estado desde esas colecciones.

## Nota de seguridad

- **Emisión de PLACETAS (`emitir`/`quemar`)**: usa una clave dedicada (`BANK_EMISSION_KEY`, cabecera `x-emission-key`), separada de la clave CRM compartida. No es posible emitir por la API CRM abierta ni por los flujos Junior/web.
- **Límite Junior**: una cuenta Junior no puede recibir/enviar más de 500 Pz/mes (configurable vía CNIC `CNIC-JUNIOR-LIMITE-MENSUAL` del BOLP) hacia/desde cuentas no-Junior, y solo con organismos/entidades de La Placeta o el cotitular legal del menor.

Una clave embebida en una app Android puede extraerse con ingenieria inversa. La app movil de produccion debe usar Bearer PlacetaID y dejar el secreto HMAC solo para backend/web. Para endurecer aun mas, añade Play Integrity API: la app pide un token de integridad, el servidor lo valida contra Google y solo acepta escrituras desde builds legitimas.
