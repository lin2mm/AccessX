# AccessX prototype

AccessX is an Express-backed access-control demo with a browser-based PWA.
Without TTLock credentials it uses demo data and does not control physical locks.

## Run locally

```sh
npm ci
npm start
```

The demo serves read-only API data by default. Set `ADMIN_TOKEN` in the process
environment to enable writes; the browser's Admin token field keeps the token
in memory for the current page only. Do not put the token in source control.

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
