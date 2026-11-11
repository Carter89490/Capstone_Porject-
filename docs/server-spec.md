# Server Specification

ASP.NET Core app (`Server` project, minimal APIs) that enrolls client agents, receives their uploads, stores them per client, and serves the web portal and its data. Routes, payloads and auth are defined in `api-contract.md`. Detailed pseudocode: `server-pseudocode.md`.

## Hard rules (decided)

- **HTTPS only**, HSTS on. Clients authenticate with a per-client API key; portal users with a session cookie (`api-contract.md`).
- **Client ID comes only from authentication.** The upload carries no client ID the server trusts; the API key decides which DB is written, so one client can never write into another's DB.
- **One SQLite DB per client ID** (`<dataDir>/<clientId>.db`), created on the client's first upload.
- **Per-client DBs change only when that client's upload arrives.** No timers, background jobs or portal actions write to them. Portal endpoints open them read-only, and reports are built on demand and never stored.
- **`index.db` changes only on these events** (decided by Sam, 2026-11-11): a client upload (including a rejected one, which can raise an alert), an enrollment, an admin action in the portal (deploy agent, new enrollment, revoke, client edit, user change, acknowledging an alert), and a login attempt (lockout counters, audit log). Nothing else writes to it.
- **Never delete history.** No endpoint deletes a client, a scan or a `Data` row. Revoking a client stops its uploads and keeps its data.

## Config

`server-config.json` (sample committed as `Server/server-config.example.json`; secrets come from environment variables or `dotnet user-secrets`):

| Field | Example | Notes |
|---|---|---|
| `dataDir` | `C:\FileGuardServer\clients` | One `<clientId>.db` per client |
| `indexDbPath` | `C:\FileGuardServer\index.db` | Clients, credentials, users, alerts, audit log |
| `tempDir` | `C:\FileGuardServer\incoming` | Uploads land here before validation |
| `uploadsDir` | `C:\FileGuardServer\uploads` | Merged raw uploads, `<clientId>/scan_<scanStartedAt>.db` |
| `rawUploadsToKeep` | `2` | Newest merged uploads kept per client; older ones are deleted |
| `logPath` | `C:\FileGuardServer\server.log` | |
| `maxUploadBytes` | `524288000` | 500 MiB |
| `publicBaseUrl` | `https://fileguard.example.edu` | Written into generated client configs as `api.baseUrl` |
| `tls.pfxPath` | `C:\FileGuardServer\tls\server.pfx` | The server's key and certificate; created if missing. Password from env `FIM_CERT_PASSWORD`. |
| `tls.names` | `["fileguard-server", "10.0.0.5"]` | Hostnames and IPs the certificate is valid for |
| `tls.validYears` | `2` | Lifetime of each certificate the server issues |
| `pinServerKey` | `true` | Put the server's public-key pin (`serverKeySha256`) in generated client configs |
| `enrollmentTokenHours` | `24` | Lifetime of an enrollment token |
| `defaultScanIntervalMinutes` | `360` | Default on the Deploy new agent form |

The first admin's password comes from env `FIM_ADMIN_PASSWORD` (see `api-contract.md`).

The server runs on **Windows** (decided by Sam, 2026-11-12).

## HTTPS certificate

The server uses a **self-signed certificate that it creates itself**; clients trust it by **pinning its public key** (decided by Sam, 2026-11-12). Nobody has to create a certificate by hand, and it is made on the server machine, so the private key never has to be copied anywhere.

On every start, before listening:

1. **No file at `tls.pfxPath`:** create a new RSA 2048 key and a certificate for it (below), save both to `tls.pfxPath` protected by `FIM_CERT_PASSWORD`, and save the public certificate alone next to it as `server.cer`.
2. **File exists:** load it. If the certificate's names differ from `tls.names`, or it expires within 30 days, **reissue** it with the **same key**: a new certificate, the old `.pfx` kept as `server.pfx.bak`, a new `server.cer`.
3. Log the public-key pin: `serverKeySha256` = lowercase hex SHA-256 of the certificate's SubjectPublicKeyInfo.

Each certificate: subject `CN=<first name in tls.names>`; Subject Alternative Names = every entry of `tls.names` (DNS names and IP addresses); server-authentication EKU; not a CA; valid from 1 day ago for `tls.validYears`. Built with .NET's `CertificateRequest`, so no extra tools or packages.

What this means in practice:

- **The server's address changes:** update `tls.names` and `publicBaseUrl`, restart the server (it reissues with the same key), and edit `api.baseUrl` in each client's config. The pin stays valid, so nothing else changes on clients.
- **Renewal** happens automatically 30 days before expiry, with the same key.
- **A new key** is only needed if the private key leaks: delete `server.pfx` and restart. The pin then changes, so every client needs a new config (Deploy new agent → new enrollment, or edit `serverKeySha256`).
- **Browsers** don't use the pin. To stop the portal's certificate warning, import `server.cer` into *Trusted Root Certification Authorities* on each admin's computer, and again after a reissue.
- `server.pfx`, `server.pfx.bak` and `server.cer` are never committed.

## Demo deployment

| Setting | Value |
|---|---|
| Server machine | `DESKTOP-UBLTR99` (Windows) |
| IP address | `192.151.132.6` (Ohio Cyber Range sandbox; private inside the range) |
| `publicBaseUrl` | `https://192.151.132.6` |
| `tls.names` | `["DESKTOP-UBLTR99", "192.151.132.6"]` |

Clients connect by IP, so they don't depend on name resolution. The server VM should keep this IP (static address or DHCP reservation).
## Storage

### `index.db` (one per server)

| Table | Columns | Notes |
|---|---|---|
| `Clients` | `clientId` PK, `displayName`, `notes`, `status` (`pending`/`active`/`revoked`), `createdAt`, `createdBy`, `enrolledAt`, `dbFile`, `hostname`, `os`, `clientVersion`, `scanIntervalMinutes`, `directoriesJson`, `firstUploadAt`, `lastUploadAt`, `lastScanStartedAt` | Agent fields (`hostname` ... `directoriesJson`) are refreshed from each upload's metadata |
| `ApiKeys` | `keyId` PK, `clientId` FK, `salt`, `hash`, `createdAt`, `revokedAt` | At most one non-revoked key per client |
| `EnrollmentTokens` | `tokenId` PK, `clientId` FK, `salt`, `hash`, `createdAt`, `createdBy`, `expiresAt`, `usedAt`, `revokedAt` | Single use |
| `PortalUsers` | `username` PK, `passwordHash`, `role` (`admin`/`viewer`), `disabled`, `createdAt`, `lastLoginAt`, `failedLogins`, `lockedUntil` | PBKDF2 hash string includes salt and iteration count |
| `AuditLog` | `eventId` PK, `at`, `username`, `action`, `target`, `detail`, `remoteIp` | Admin actions and login attempts. Never contains secrets. |
| `Alerts` | `alertId` PK, `clientId` FK, `type`, `message`, `firstAt`, `lastAt`, `count`, `acknowledgedAt`, `acknowledgedBy` | Problems the portal should show. A repeat of an unacknowledged alert (same client and type) bumps `count` and `lastAt` instead of adding a row. |

### Per-client DB (`<clientId>.db`)

- `Data`: shared schema + `active` (see `data-model.md`).
- `Scans(scanId PK, scanStartedAt UNIQUE, scanFinishedAt, receivedAt, foldersScanned, filesFound, hashedCount, errorCount, newCount, changedCount, deletedCount, unmonitoredCount, unchangedCount)`
  - `scanStartedAt`, `scanFinishedAt`, `foldersScanned` come from the upload metadata.
  - `hashedCount` = rows with a real hash; `errorCount` = error rows (files and folders); `filesFound` = `hashedCount` + file error rows. Counted by the server from the snapshot.
  - `newCount`, `changedCount`, `deletedCount`, `unmonitoredCount`, `unchangedCount` come from the merge. `newCount + changedCount + unchangedCount = hashedCount`.
- `Changes(changeId PK, scanId FK, changeType 'NEW'|'CHANGED'|'DELETED'|'UNMONITORED'|'ERROR', filePath, oldKey, newKey, oldHash, newHash, lastSeenScanId, seenCount)`, indexed on `scanId` and `filePath`. `lastSeenScanId` and `seenCount` are used only on `ERROR` rows (see "Repeated errors").
- `OpenErrors(filePath PK, changeId FK)`: the errors still going on as of the latest scan, one per path, each pointing at its `ERROR` change.
- WAL journal mode on every DB, so portal reads don't block upload writes.

### Client IDs

`clientId` becomes a file name, so it must match `^[A-Za-z0-9._-]{1,64}$` and not be `.` or `..`. The server derives it from the display name when an agent is deployed: lowercase; every character outside `[a-z0-9._-]` becomes `-`; runs of `-` collapse; leading/trailing `-` and `.` are trimmed; cut to 64; `client` if nothing is left; `-2`, `-3`, ... appended until unique. It never changes afterwards.

## Agent deployment and enrollment

1. An admin uses **Deploy new agent** (`POST /api/v1/portal/agents`). The server creates a `pending` `Clients` row and an enrollment token, and returns the client config with the token (shown once).
2. The config is copied to the machine. Folders can be added there.
3. The client calls `POST /api/v1/agent/enroll` with the token. In one transaction the server checks the token (exists, unused, unexpired, client not revoked), marks it used, revokes any earlier key, stores the new key's hash, sets `status = active` and `enrolledAt`, and saves hostname/OS/version. It returns the client ID and the key.
4. **New enrollment** for an existing client invalidates its unused tokens and issues a new one; the old key keeps working until the new token is redeemed.
5. **Revoke** sets `revokedAt` on the key and unused tokens and `status = revoked`. Data is kept.

There is no other way to register a client: an API key always belongs to a `Clients` row.

## Upload handling

1. Authenticate the API key → client ID (`401` if missing, unknown, revoked, or the client is revoked).
2. Read the multipart body. Enforce `maxUploadBytes` (`413`). Parse and validate `metadata` (`api-contract.md`), else `400 invalid_metadata`.
3. Save `scanDb` to `tempDir` under a server-generated name (never the uploaded name).
4. **Validate** (the file is untrusted): open read-only with pooling off, `PRAGMA quick_check` must be `ok`, `Data` must have the shared columns, and only `Data` is read. Each row:
   - `hash` is 64 lowercase hex or a known error code
   - `fileSize` is a whole number ≥ 0; NULL allowed only on error rows
   - `filePath` is not blank
   - If a path repeats, a real hash beats an error code, then the later `hashDate` wins
   Failure → `400 invalid_upload`.
5. Take a **per-client lock** (one upload at a time per client; single server process).
6. Merge (below) in **one transaction**, then update the client's `Clients` row (agent fields from metadata, `firstUploadAt` if unset, `lastUploadAt`, `lastScanStartedAt`).
7. **Keep the raw upload** (decided by Sam, 2026-11-12): move the temp file to `<uploadsDir>/<clientId>/scan_<scanStartedAt>.db`, then delete that client's older raw uploads so only the newest `rawUploadsToKeep` (2) remain, ordered by the `scanStartedAt` in the name. Like the client's retention: a failed delete is logged and never fails the upload. Rejected uploads (400, 409, 413) and repeats of an already-merged scan are not kept; their temp file is deleted.

Responses: see `api-contract.md` (200 with counts, 400, 401, 409, 413).

### Rejected out-of-order scans

A scan older than one already merged is rejected with `409` and never merged: old data must not overwrite newer data (decided by Sam, 2026-11-12). This usually means the client's clock went backwards. The server:

- writes a warning to its log (`server.log`) with the client ID, the rejected `scanStartedAt` and the latest merged one, and
- raises a `scan_out_of_order` **alert** for that client (see `Alerts`), which the portal shows until an admin acknowledges it.

The client logs the 409 as an error that names the likely cause (its clock).

## Merge rule

- **Idempotent:** if `scanStartedAt` was already merged, return the earlier counts with `alreadyMerged: true` and change nothing.
- **Ordered:** a scan older than the latest merged one is rejected (`409`).
- Load current state: every `active = 1` row, by path. Then for each upload row:

| Upload row | Action | Change logged |
|---|---|---|
| Error code in `hash`, **same code as the path's open error** | Nothing new is stored: the open `ERROR` change gets `lastSeenScanId` = this scan and `seenCount + 1`. Last good row stays active. | none (counted on the open one) |
| Error code in `hash`, **new or different error** | Insert with `active = 0`. Leave the path's last good row active. Not counted as deleted. Becomes the path's open error. | `ERROR` |
| Same path, same hash as active row | Skip (only `hash` is compared; `fileSize` is informational) | none |
| Same path, different hash | Set old row `active = 0`, insert new row `active = 1` | `CHANGED` |
| Path with no active row | Insert `active = 1` (includes a file that was deleted earlier and came back) | `NEW` |

- Then each active path **not** in the upload is checked, in this order:
  1. **Not under any of the client's current roots** (`metadata.agent.directories`): the folder was removed from the client's config, so the file is **no longer monitored**, not deleted (decided by Sam, 2026-11-12). Set `active = 0`, log `UNMONITORED`, count it in `unmonitoredCount`. If the folder is added back later, its files return as `NEW`.
  2. **Under a folder that arrived with `DIR_UNREADABLE` or `DIR_NOT_FOUND`** this scan: unknown, so keep the active row; nothing is logged for it (the folder's `ERROR` explains it).
  3. **Otherwise deleted:** set `active = 0`, log `DELETED`.
- Close every open error whose path did **not** arrive with an error this scan (the error ended): remove it from `OpenErrors`. Its `ERROR` change keeps the range it covered.
- Write the `Scans` row (metadata, counted totals, merge counts) and commit.

Deleted, no longer monitored and superseded all mean `active = 0`; the `Changes` log says which.

### Repeated errors

An error is stored **once, when it starts or changes**, not on every scan (decided by Sam, 2026-11-12), in keeping with storing nothing for things that haven't changed. Its `ERROR` change records the first scan (`scanId`), the last scan it was seen in (`lastSeenScanId`) and how many scans it lasted (`seenCount`).

- "LOCKED → LOCKED" on the next scan: counted on the open error. "LOCKED → PERMISSION_DENIED": a new error row and change. Readable again, then failing later: a new one.
- Because scans merge strictly in order and every open error is either extended or closed on each scan, the errors going on **during scan S** are exactly the `ERROR` changes with `scanId ≤ S ≤ lastSeenScanId`. That is how the scan imports tab lists each scan's failures.
- `Scans.errorCount` still counts every error in each snapshot, so per-scan totals and trends are unaffected.

## Portal endpoints

Listed in `api-contract.md` ("Portal data API" and "Admin API"). Notes for implementing them:

- **Scan imports** (`/portal/scans`, `/portal/summary`) read the `Scans` table of each client DB plus `Clients` for display names. All-client lists merge each client's page by `scanStartedAt`.
- **Tree** (`/clients/{id}/tree`) is built from the client's active `Data` rows, the latest scan's `Changes` (badges, deleted files) and `OpenErrors` (error badges, folder errors). Children of a folder are found with an ordinal prefix query on `path + "/"` (escape `%` and `_` in `LIKE`), grouped by the next path segment. The roots are the client's `directoriesJson`.
- **File details** (`/clients/{id}/file`) come from the `Changes` log joined to `Scans` and `Data`, one event per change.
- **Trends** read the `Scans` table.
- **Report export** re-queries each item and renders one self-contained HTML file. Nothing is saved.
- Role checks: `viewer` for reads and exports, `admin` for the Admin API.

## Web portal

Static pages in **plain HTML, CSS and JavaScript, no framework** (decided by Sam, 2026-11-12), served by the server from `Server/wwwroot` and built from the agreed prototype in `web-portal-prototype.md` (login; tabs **Scan imports**, **Client files**, **Trends**; report tray). The real portal adds:

- a **Deploy new agent** button near the top (admins only), a client actions menu (new enrollment, revoke, edit), and a small user management page for admins;
- an **alerts** indicator in the top bar with the count of unacknowledged alerts, and a list where admins acknowledge them;
- a **time zone toggle** in the top bar: **UTC** or **Local** (the viewer's computer time zone). Remembered per browser; the API always sends Unix seconds, so the toggle only changes how times are displayed, report exports included (decided by Sam, 2026-11-12);
- a **No longer monitored** badge for `UNMONITORED` events.

Pages call only the endpoints in `api-contract.md`.
