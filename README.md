# upstage2API

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put API_KEY
npm run deploy
```

## Endpoints

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

## Chat

```bash
curl https://upstage-web-2api.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"solar-pro3","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

```bash
curl 'https://upstage-web-2api.<subdomain>.workers.dev/v1/chat/completions?include_think=false' \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"solar-pro3","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

## Models

```bash
curl https://upstage-web-2api.<subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer <API_KEY>"
```

## Local

```dotenv
API_KEY=<API_KEY>
```

```bash
npm install
npm run dev
```

## Test

```bash
npm test
```
