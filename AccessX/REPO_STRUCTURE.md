# Repository structure

This repo is organized around a small server + auth + policy layer plus data and worker modules.

```text
AccessX/
├── README.md
├── .gitignore
├── package.json
├── package-lock.json
├── acl.js
├── auth.js
├── auth.test.js
├── mirror.js
├── policy-core.js
├── policy-core.test.js
├── server.js
├── ttlock.js
├── worker.js
├── wrangler.jsonc
├── data/
├── drivers/
├── migrations/
├── public/
└── ...
```

## Notes

- `auth.js` and `policy-core.js` are core access-control logic.
- `server.js` / `worker.js` are runtime entry points.
- `data/`, `drivers/`, `migrations/` hold runtime state and integration support.
