# AccessX demo

AccessX is an access-control demo with a browser-based PWA. The local Express
server and Cloudflare Worker both use demo data and do not control physical locks.

## Run locally

```sh
npm ci
npm start
```

The demo serves read-only API data by default. Set `ADMIN_TOKEN` in the process
environment to enable writes; the browser's Admin token field keeps the token
in memory for the current page only. Do not put the token in source control.

## Cloudflare preview

The hosted build serves the PWA as static assets, the demo API from a Worker,
and demo state from D1. It is demo-only; TTLock credentials and real-lock
operations are intentionally not enabled in the Worker.

1. Install dependencies and log Wrangler in:

   ```sh
   npm ci
   npx wrangler login
   ```

2. Create a D1 database, then copy its `database_id` into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create accessx-demo
   ```

3. Apply the schema locally before `npm run dev:cloudflare`, or remotely before
   deployment:

   ```sh
   npm run cf:db:migrate:local
   npm run cf:db:migrate:remote
   ```

4. Set an admin token as a Cloudflare secret and deploy:

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npm run cf:deploy
   ```

Do not enable public writes. For live lock data, this prototype still needs
role-based authorization, stronger audit controls, and a separate production
security review.

## Authentication

- All `POST`, `PUT`, and `DELETE` API requests require `Authorization: Bearer
  <ADMIN_TOKEN>`, including requests made in demo mode.
- Demo mode allows read-only API access by default.
- When TTLock credentials are configured, API reads require the admin token by
  default. Set `AUTH_OPEN_READS=1` only when exposing live lock and user data is
  intentional. Set `AUTH_OPEN_READS=0` to require the token for reads in demo
  mode too.
- Failed token attempts are rate-limited in memory per client IP.

This is still a prototype, not a production access-control service. Before
connecting real locks or real user data, add role-based authorization, durable
audit storage, operational monitoring, and a reviewed HTTPS deployment setup.
