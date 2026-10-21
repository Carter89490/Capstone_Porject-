# API Contract (client ↔ server)

The secure API is **owned by teammates**. This file records what is decided and what client/server code currently assumes. Anything marked `API_PLACEHOLDER` may change when the API team publishes their contract; update this file when it does.

## Decided

- **HTTPS only.** The client refuses a non-HTTPS base URL; the server listens on HTTPS only.
- **Per-client key or certificate** authenticates each client.
- **The API tells the server which client is sending.** No client ID is stored in the DB or sent as a payload field.
- Keys, certs, and passwords are never hard-coded or committed. Server-side API keys are stored as salted hashes, never in plain text.

## Current assumptions (`API_PLACEHOLDER`)

### Upload a scan

```
POST /api/v1/scans
Content-Type: multipart/form-data
Auth: client certificate, or API key header (e.g. Authorization: Bearer <key>)

Fields:
  scanStartedAt  Unix seconds when the scan started (also the server's idempotency key)
  scanDb         the client's SQLite snapshot file (table Data, see data-model.md)
```

| Status | Meaning | Client action |
|---|---|---|
| 200 | Merged (or already merged); body has counts | Done |
| 400 | Bad or corrupt upload | Log; don't retry the same file |
| 401 / 403 | Auth failure | Log; don't retry |
| 409 | An equal or newer scan was already merged | Log; don't retry |
| network error / 5xx | Transient | Retry with backoff, a few times |

### Server side

- The server needs only two answers from the auth layer:
  1. For client calls: which `clientId` is this request? (claim `clientId`, policy `ClientPolicy`)
  2. For portal calls: is this a logged-in portal user? (policy `PortalUserPolicy`)
- With certificate auth, the cert subject or thumbprint maps to a client ID.

## Undecided

- Key vs. certificate, header names, and how a new client is issued its credential.
- Whole SQLite file vs. JSON rows as the upload format (current assumption: whole file).
- Upload retry policy and size limit.
