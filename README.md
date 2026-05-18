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
   - `PLACETA_APP_ID`
   - `PLACETA_APP_SECRET`
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

Todos los endpoints requieren firma HMAC.

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
hex(HMAC_SHA256(PLACETA_APP_SECRET, payload))
```

El servidor rechaza:

- App ID incorrecto.
- Timestamp con más de 5 minutos.
- Nonce repetido.
- Firma inválida.
- Body mayor a 20 MB.

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

Una clave embebida en una app Android puede extraerse con ingeniería inversa. Para producción fuerte, añade Play Integrity API: la app pide un token de integridad, el servidor lo valida contra Google y solo acepta firmas desde builds legítimas.
