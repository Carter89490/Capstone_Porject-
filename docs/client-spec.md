# Client Specification

Console app (`Client` project) that runs on each monitored machine, ideally hosted as a Windows Service or systemd service. Detailed pseudocode: `client-pseudocode.md`.

## Config file

JSON, path given as the first argument (default `client-config.json`). Commit only a sample with fake values (e.g. `Client/client-config.example.json`).

```json
{
  "clientId": "lab-pc-07",
  "scanIntervalHours": 6,
  "directories": [ "C:\\Data\\Important", "D:\\Records" ],
  "outputDir": "C:\\ProgramData\\FIM\\scans",
  "logPath": "C:\\ProgramData\\FIM\\client.log",
  "api": {
    "baseUrl": "https://fim-server.example.edu",
    "clientCertPath": "C:\\ProgramData\\FIM\\client.pfx",
    "apiKeyEnvVar": "FIM_API_KEY"
  }
}
```

| Field | Required | Rules |
|---|---|---|
| `clientId` | yes | Used only for local file names and logs. Never written to the DB or sent as a field. |
| `scanIntervalHours` | yes | Number > 0; fractions allowed (0.5 = every 30 minutes). |
| `directories` | yes | At least one. Normalized and de-duplicated on load. |
| `outputDir`, `logPath` | yes | Where snapshots and logs go. |
| `api` | yes | Fields are the API team's (`API_PLACEHOLDER`). Secrets come from env vars or the OS store, never the file. |

## Schedule

- Run one scan at startup, then one every `scanIntervalHours`, **measured from the start of each scan** so runs don't drift.
- If a scan takes longer than the interval, the next one starts right away.
- A failed run is logged and never stops the schedule.

## Scan behavior

1. Create a new SQLite file per scan: `<outputDir>/scan_<clientId>_<unixStart>.db`, table `Data` (see `data-model.md`). Insert all rows in one transaction.
2. For each configured root:
   - Missing root: record a `DIR_NOT_FOUND` row for it and continue.
   - Walk it recursively **by hand** (a stack of folders), not `SearchOption.AllDirectories`, which aborts on the first access-denied folder.
   - Don't follow symlinks or junctions (reparse points).
3. For each file: normalize the path, skip it if already seen (overlapping roots), then hash it with streamed SHA-256 (`FileShare.ReadWrite`, 1 MB buffer, async). Size in KiB is taken from the bytes actually hashed.
4. **Failures, first try:** a file that can't be hashed goes on a retry list; a folder that can't be listed goes on a failed-folder list. Log it and keep going. One bad file or folder never stops a scan.
5. **Retry once after the full scan:**
   - Re-walk each failed folder. Files found now are hashed normally. A folder that fails again is recorded with `DIR_UNREADABLE`, `fileSize` NULL.
   - Re-try each failed file. If it fails again, record it with its error code; `fileSize` is filled if the file system still reports it, otherwise NULL.
6. Exception to error code mapping:
   - `UnauthorizedAccessException` → `PERMISSION_DENIED`
   - `FileNotFoundException` / `DirectoryNotFoundException` → `NOT_FOUND`
   - `IOException` with HResult low word 32 or 33 (sharing/lock violation) → `LOCKED`
   - Any other `IOException` → `UNREADABLE`
7. Commit, close, log counts (hashed, errors).

## Upload

- Upload the snapshot DB to the server through the secure API (HTTPS only; refuse a non-HTTPS base URL).
- Current placeholder: `POST /api/v1/scans`, multipart with `scanStartedAt` (Unix seconds) and `scanDb` (the file). **No client ID field**; the server takes identity from the credential. See `api-contract.md`.
- Retry a few times with backoff on network errors; don't retry auth failures.
- If upload ultimately fails, keep the snapshot for debugging but **don't re-send it later**: the next scan uploads newer data, and the server rejects scans older than one it has already merged.

## Not the client's job

- Diffing against earlier scans (the server does all of it).
- Remembering previous scans.
- Choosing the auth scheme or API routes.
