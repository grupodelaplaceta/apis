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

Una clave embebida en una app Android puede extraerse con ingenieria inversa. La app movil de produccion debe usar Bearer PlacetaID y dejar el secreto HMAC solo para backend/web. Para endurecer aun mas, añade Play Integrity API: la app pide un token de integridad, el servidor lo valida contra Google y solo acepta escrituras desde builds legitimas.
