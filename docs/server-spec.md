# Server Specification

ASP.NET Core app (`Server` project, minimal APIs) that receives client uploads, stores them per client, and serves data and reports to the web portal. Detailed pseudocode: `server-pseudocode.md`.

## Hard rules (decided)

- **HTTPS only.** Client calls are authenticated with a per-client key or certificate (API team's code).
- **Client ID comes only from authentication.** The upload carries no client ID, and the authenticated ID decides which DB is written, so one client can never write into another's DB.
- **One SQLite DB per client ID** (`<dataDir>/<clientId>.db`). An authenticated client ID the server hasn't seen gets a new DB and an entry in the client index.
- **DBs change only when a client upload arrives.** No timers, background jobs, or portal actions write to them. Portal endpoints open client DBs read-only, and reports are built on demand and never stored.
- **Never delete history.**

## Storage

- `index.db`: table `Clients(clientId PK, dbFile, firstSeen, lastUploadAt, lastScanStartedAt)`.
- Per-client DB: `Data` (shared schema + `active`, see `data-model.md`), plus:
  - `Scans(scanId PK, scanStartedAt UNIQUE, receivedAt, fileCount, newCount, changedCount, deletedCount, unchangedCount, errorCount)`
  - `Changes(changeId PK, scanId FK, changeType 'NEW'|'CHANGED'|'DELETED'|'ERROR', filePath, oldKey, newKey, oldHash, newHash)`, indexed on `scanId` and `filePath`
- WAL journal mode so portal reads don't block upload writes.
- `clientId` becomes a file name, so it must match `^[A-Za-z0-9._-]{1,64}$` and not be `.` or `..`.

## Upload handling

1. Get the client ID from the authenticated user; validate it.
2. Save the uploaded file to `tempDir` under a server-generated name (never the uploaded name). Enforce a size limit.
3. **Validate** (the file is untrusted): open read-only with pooling off, `PRAGMA quick_check` must be `ok`, `Data` must have the shared columns, and only `Data` is read. Each row:
   - `hash` is 64 lowercase hex or a known error code
   - `fileSize` is a whole number ≥ 0; NULL allowed only on error rows
   - `filePath` is not blank
   - If a path repeats, a real hash beats an error code, then the later `hashDate` wins
4. Take a **per-client lock** (one upload at a time per client; single server process assumed).
5. Merge (below) in **one transaction**, then update the index. Delete the temp file.

Responses: 200 with merge counts; 400 for bad input; 409 if an equal or newer scan was already merged.

## Merge rule

- **Idempotent:** if `scanStartedAt` was already merged, return the earlier result and change nothing.
- **Ordered:** a scan older than the latest merged one is rejected (409).
- Load current state: every `active = 1` row, by path. Then for each upload row:

| Upload row | Action | Change logged |
|---|---|---|
| Error code in `hash` | Insert with `active = 0`. Leave the path's last good row active. Not counted as deleted. Every error row is stored, even repeats. | `ERROR` |
| Same path, same hash as active row | Skip (only `hash` is compared; `fileSize` is informational) | none |
| Same path, different hash | Set old row `active = 0`, insert new row `active = 1` | `CHANGED` |
| Path with no active row | Insert `active = 1` (includes a file that was deleted earlier and came back) | `NEW` |

- Then every active path **not** in the upload is **deleted**: set `active = 0`, log `DELETED`. **Exception:** paths under a folder that arrived with `DIR_UNREADABLE` or `DIR_NOT_FOUND` this scan keep their active row and are not reported deleted.
- Write the counts to the `Scans` row and commit.

Deleted and superseded both mean `active = 0`; the `Changes` log says which.

## Portal endpoints (`ASSUMPTION(portal-pending)`)

All read-only, all under `/api/v1/portal`, all require a logged-in portal user, list endpoints paged (`page`, `pageSize` ≤ 1000):

| Route | Returns |
|---|---|
| `GET /clients` | Known clients with first-seen and last-upload times |
| `GET /clients/{clientId}` | Current file count, latest scan, total scans |
| `GET /clients/{clientId}/scans?from=&to=` | Scan list |
| `GET /clients/{clientId}/scans/{scanId}/changes?type=` | Changes in one scan |
| `GET /clients/{clientId}/files?pathPrefix=&includeInactive=` | Current (or all) rows |
| `GET /clients/{clientId}/files/history?path=` | A file's full timeline from the `Changes` log: every NEW, CHANGED, DELETED and ERROR event with its scan time and hashes |
| `POST /reports` | Report over clients, time range, change types; JSON or CSV. POST only to carry filters; still read-only. |

Unknown client ID → 404. Escape `%` and `_` in LIKE prefixes.

## Web portal

Hosted by the server, with **login** and **report generation** (changed, new, deleted files per client). The UI/UX is **not designed yet**; it will decide which endpoints and extra data the server needs. Keep the endpoints above generic until then.
