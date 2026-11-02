# File Integrity Monitor

A senior design project that detects files that have been **tampered with or corrupted**.

A **client** runs on each monitored machine. It fingerprints every file in its configured folders with SHA-256 and saves the results to a small SQLite snapshot. The snapshot is uploaded to a **central server**, which keeps one database per client, compares each upload with the last one, and records which files are **new**, **changed**, **deleted**, or **unreadable**. A **web portal** hosted by the server shows the results as reports.

If even one byte of a file changes, its SHA-256 fingerprint changes, so comparing fingerprints over time shows exactly which files were touched.

> The full specification lives in [`docs/`](docs/). This README is the overview; when the two disagree, `docs/` wins.

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Client: one scan](#client-one-scan)
- [Upload and merge](#upload-and-merge)
- [Database design](#database-design)
- [Error codes](#error-codes)
- [Path normalization](#path-normalization)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Project status](#project-status)
  - [Done](#done)
  - [To do](#to-do)
  - [Open questions](#open-questions)
- [Documentation](#documentation)

## How it works

| Part | What it does | Owner |
|---|---|---|
| **Client** | Runs on each monitored machine. Reads a config file, hashes files recursively, writes a local SQLite snapshot, uploads it. | Sam |
| **Secure API** | HTTPS transport and per-client authentication (key or certificate) between client and server. | Teammates |
| **Server** | Receives uploads, keeps one SQLite DB per client, merges each upload, serves data and reports. | Sam |
| **Web portal** | Login and report generation, hosted by the server. UI/UX still pending. | Team (pending) |

Key decisions:

- The client sends a **fresh full snapshot** every scan. The client never diffs; the server does all comparison.
- The client scans **once at startup** and then every `scanIntervalMinutes`, timed from the start of each scan so the schedule doesn't drift.
- Files and folders that can't be read are **retried once** after the full scan, then recorded with a fixed [error code](#error-codes) instead of a hash. One bad file never stops a scan.
- The client keeps **at most 2 local snapshots**. The server does long-term storage.
- The snapshot has **no client ID column**. The server learns who is sending from the client's credential, never from the uploaded data.
- The server keeps **one SQLite DB per client**, and its DBs change **only when an upload arrives**. The portal only reads.
- **History is never deleted.** A changed file gets a new row, and the old row is marked inactive.
- **HTTPS only**, with a per-client key or certificate.

## Architecture

```mermaid
flowchart LR
    subgraph Machine["Monitored machine"]
        Config[/"client-config.json"/]
        Files[("Monitored folders")]
        Client["Client<br/>(console app)"]
        Snap[("Snapshot DB<br/>scan_clientId_unixStart.db")]
        Config --> Client
        Files -- "read + SHA-256" --> Client
        Client -- "write rows" --> Snap
    end

    subgraph ServerHost["Central server (ASP.NET Core)"]
        Auth["Secure API<br/>auth: key or cert"]
        Merge["Validate + merge"]
        Index[("index.db<br/>known clients")]
        PerClient[("clientId.db<br/>Data, Scans, Changes")]
        PortalApi["Portal endpoints<br/>(read-only)"]
        Auth -- "clientId" --> Merge
        Merge --> Index
        Merge --> PerClient
        PerClient --> PortalApi
        Index --> PortalApi
    end

    Browser["Web portal<br/>(login, reports)"]

    Snap -- "HTTPS upload<br/>POST /api/v1/scans" --> Auth
    PortalApi --> Browser
```

Data flow, end to end:

```mermaid
flowchart TD
    A["Read config"] --> B["Walk folders, SHA-256 each file"]
    B --> C["Retry failures once"]
    C --> D["Write snapshot (table Data)"]
    D --> E["Upload over HTTPS with per-client credential"]
    E --> F["Server: authenticate → client ID → that client's DB"]
    F --> G["Validate upload"]
    G --> H["Merge: new / changed / deleted / error"]
    H --> I["Changes log"]
    I --> J["Portal reads → reports"]
```

## Client: one scan

The schedule:

```mermaid
sequenceDiagram
    autonumber
    participant Sched as Scheduler
    participant Scan as Scanner
    participant DB as Snapshot DB
    participant Ret as Retention
    participant API as Secure API (pending)

    Note over Sched: Program starts
    loop Every scanIntervalMinutes (first run immediately)
        Sched->>Scan: Scan all configured folders
        Scan->>DB: Create new file, insert all rows in one transaction
        Scan-->>Sched: Counts (hashed, errors)
        Sched--)API: Upload snapshot (not built yet)
        Sched->>Ret: Delete all but the 2 newest snapshots
        Note over Sched: Wait the rest of the interval<br/>(start right away if the scan ran long)
    end
```

Inside a scan:

```mermaid
flowchart TD
    Start(["Start scan"]) --> NewDb["Create fresh snapshot DB,<br/>begin transaction"]
    NewDb --> Root{"For each root:<br/>does it exist?"}
    Root -- "No" --> DirNF["Record DIR_NOT_FOUND"]
    Root -- "Yes" --> Walk["Walk folders by hand<br/>(skip symlinks and junctions)"]
    Walk -- "folder can't be listed" --> FailDir["Add to failed-folder list"]
    Walk -- "file" --> Seen{"Path already seen?"}
    Seen -- "Yes" --> Walk
    Seen -- "No" --> Hash["Stream SHA-256"]
    Hash -- "OK" --> Row["Insert row"]
    Hash -- "error" --> RetryList["Add to retry list"]
    DirNF --> Pass2
    Row --> Pass2
    RetryList --> Pass2
    FailDir --> Pass2
    Pass2["After all roots:<br/>retry pass"] --> RD["Re-walk failed folders"]
    RD -- "fails again" --> DirUR["Record DIR_UNREADABLE"]
    RD -- "lists now" --> Hash2["Hash the files found"]
    Pass2 --> RF["Re-hash failed files"]
    RF -- "OK" --> Row2["Insert row"]
    RF -- "fails again" --> Code["Record error code<br/>(LOCKED, PERMISSION_DENIED,<br/>NOT_FOUND, UNREADABLE)"]
    DirUR --> Commit
    Hash2 --> Commit
    Row2 --> Commit
    Code --> Commit
    Commit(["Commit, close, log counts"])
```

If the scan itself fails (for example, the disk is full), its unfinished DB is deleted so it is never uploaded, and the schedule carries on.

Example config ([`Client/client-config.example.json`](Client/client-config.example.json)):

```json
{
  "clientId": "demo-pc",
  "scanIntervalMinutes": 5,
  "directories": [ "C:\\Test" ],
  "outputDir": "C:\\FIM\\scans",
  "logPath": "C:\\FIM\\client.log",
  "api": {
    "baseUrl": "https://fim-server.example.edu",
    "clientCertPath": "C:\\FIM\\client.pfx",
    "apiKeyEnvVar": "FIM_API_KEY"
  }
}
```

| Field | Rules |
|---|---|
| `clientId` | Required. Used only for local file names and logs; never written to the DB or sent. |
| `scanIntervalMinutes` | Required, > 0. Fractions allowed (0.5 = every 30 seconds). |
| `directories` | Required, at least one. Normalized and de-duplicated on load. |
| `outputDir`, `logPath` | Required. Where snapshots and the log go. Keep them outside the scanned folders. |
| `api` | Required. Placeholder fields until the API team defines them. Secrets come from env vars, never the file. |

## Upload and merge

> **Planned.** The upload and the server are not built yet. This follows [`server-spec.md`](docs/server-spec.md) and [`api-contract.md`](docs/api-contract.md); routes and auth are placeholders owned by the API team.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as Secure API
    participant S as Server
    participant I as index.db
    participant D as clientId.db

    C->>A: POST /api/v1/scans (scanStartedAt, scanDb)<br/>HTTPS + key or certificate
    A->>A: Authenticate → clientId
    A->>S: Upload + clientId
    S->>S: Save to temp file, check size limit
    S->>S: Validate (quick_check, columns, every row)
    alt Invalid upload
        S-->>C: 400
    else scanStartedAt already merged
        S-->>C: 200 with the earlier counts (no change)
    else Older than the latest merged scan
        S-->>C: 409
    else Valid and newer
        S->>S: Take per-client lock
        S->>D: Merge in ONE transaction
        S->>I: Update lastUploadAt, lastScanStartedAt
        S-->>C: 200 with merge counts
    end
```

How each uploaded row is merged against the client's current (active) rows:

```mermaid
flowchart TD
    R["Upload row"] --> E{"hash is an<br/>error code?"}
    E -- "Yes" --> ER["Insert with active = 0<br/>Keep last good row active<br/>Log ERROR"]
    E -- "No" --> P{"Active row for<br/>this path?"}
    P -- "No" --> N["Insert active = 1<br/>Log NEW"]
    P -- "Yes" --> H{"Same hash?"}
    H -- "Yes" --> U["Skip (unchanged)"]
    H -- "No" --> CH["Old row → active = 0<br/>Insert new row active = 1<br/>Log CHANGED"]
    ER & N & U & CH --> Done["After all rows"]
    Done --> Del["Active paths missing from the upload<br/>→ active = 0, log DELETED<br/>(except under a folder that arrived as<br/>DIR_UNREADABLE or DIR_NOT_FOUND)"]
    Del --> Counts["Write Scans row, commit"]
```

The life of one file path on the server:

```mermaid
stateDiagram-v2
    [*] --> Active: First seen (NEW)
    Active --> Active: Same hash (no change)
    Active --> Active: Different hash (CHANGED), old row superseded
    Active --> Active: Unreadable (ERROR), last good row stays active
    Active --> Deleted: Missing from upload (DELETED)
    Deleted --> Active: Comes back (NEW)
```

## Database design

### Client snapshot (one file per scan)

Shared schema; client, API and server all depend on it. Don't change it without the whole team agreeing.

```mermaid
erDiagram
    Data {
        INTEGER Key PK "row id"
        INTEGER fileSize "KiB rounded up; 0 if empty; NULL on some error rows"
        TEXT filePath "normalized absolute path (NOT NULL)"
        TEXT hash "64 lowercase hex, or an error code (NOT NULL)"
        INTEGER hashDate "Unix seconds (NOT NULL)"
    }
```

### Server (planned)

`index.db` lists known clients, and each client gets its own `<clientId>.db`.

```mermaid
erDiagram
    Clients {
        TEXT clientId PK "letters, digits, dot, dash, underscore; max 64"
        TEXT dbFile "path of the client's DB"
        INTEGER firstSeen
        INTEGER lastUploadAt
        INTEGER lastScanStartedAt
    }
```

```mermaid
erDiagram
    Scans ||--o{ Changes : "logs"
    Data |o--o{ Changes : "oldKey / newKey"

    Data {
        INTEGER Key PK "server-assigned"
        INTEGER fileSize "KiB"
        TEXT filePath "indexed"
        TEXT hash "hash or error code"
        INTEGER hashDate "Unix seconds"
        INTEGER active "1 = current, 0 = superseded / deleted / error"
    }
    Scans {
        INTEGER scanId PK
        INTEGER scanStartedAt UK "idempotency key"
        INTEGER receivedAt
        INTEGER fileCount
        INTEGER newCount
        INTEGER changedCount
        INTEGER deletedCount
        INTEGER unchangedCount
        INTEGER errorCount
    }
    Changes {
        INTEGER changeId PK
        INTEGER scanId FK
        TEXT changeType "NEW, CHANGED, DELETED, ERROR"
        TEXT filePath "indexed"
        INTEGER oldKey FK
        INTEGER newKey FK
        TEXT oldHash
        TEXT newHash
    }
```

- At most one `active = 1` row per path (unique partial index `IX_Data_ActivePath`).
- Error rows are always stored with `active = 0`.
- WAL journal mode, so portal reads don't block upload writes.

## Error codes

Stored in `hash` when a file or folder still can't be read after its retry. Identical on client and server.

| Code | Applies to | Meaning |
|---|---|---|
| `LOCKED` | file | Another process holds a lock |
| `PERMISSION_DENIED` | file | No read access |
| `NOT_FOUND` | file | File vanished mid-scan |
| `UNREADABLE` | file | Any other I/O failure |
| `DIR_UNREADABLE` | folder | Folder couldn't be listed |
| `DIR_NOT_FOUND` | folder | A configured root doesn't exist (e.g. drive unplugged) |

A real hash is always 64 hex characters, so a code can never be mistaken for one.

## Path normalization

So the same file always produces the same string:

1. `Path.GetFullPath` (absolute, resolves `.` and `..`)
2. Replace `\` with `/`
3. Trim a trailing separator, except for a bare root like `C:/`
4. On Windows, lowercase. On Linux/macOS, keep the casing.

Example: `C:\Test\Sub\..\Report.TXT` → `c:/test/report.txt`

## Getting started

Requires the **.NET 10 SDK**. Full setup checklist: [`docs/dev-setup.md`](docs/dev-setup.md).

```sh
dotnet build          # must finish with 0 warnings, 0 errors
dotnet test
dotnet format         # run before every push
```

Run the client:

1. Copy `Client/client-config.example.json` to `Client/client-config.json` (gitignored) and edit the folders.
2. `dotnet run --project Client -- Client/client-config.json`, or press **F5** with the **Client** launch config.
3. Press **Ctrl+C** to stop.

To run on a machine without the SDK, publish a self-contained build and copy the folder over:

```sh
dotnet publish Client -c Release -r win-x64 --self-contained
```

## Repository layout

```
Integrity.slnx               solution
global.json                  pinned .NET SDK
Directory.Build.props        shared build settings (warnings are errors)
Directory.Packages.props     central NuGet versions
Client/                      console client
  Program.cs                 entry point, Ctrl+C handling
  ClientConfig.cs            load + validate config
  ScanScheduler.cs           startup scan + interval loop
  Scanner.cs                 folder walk, hashing, retry pass
  ScanDatabase.cs            snapshot DB (table Data)
  SnapshotRetention.cs       keep the 2 newest snapshots
  FileHasher.cs              streamed SHA-256, KiB rounding
  HashError.cs               shared error codes
  PathNormalizer.cs          path normalization
  FileLogger.cs              console + file log
Server/                      ASP.NET Core server (template only so far)
Tests/                       xUnit tests
docs/                        specification
```

## Project status

> Keep these three sections current. When a feature is built, move it from **To do** to **Done**. When a question is answered, remove it from **Open questions** (and from [`docs/open-questions.md`](docs/open-questions.md)) and record the decision in the matching spec.

### Done

- **Repo setup:** .NET 10 solution with `Client`, `Server`, `Tests`; pinned SDK; shared build settings with warnings as errors; central package versions; `.editorconfig`, `.gitattributes`; VS Code extensions, settings, tasks and launch configs.
- **Client config:** loading and validation; folders normalized and de-duplicated.
- **Client schedule:** scan at startup, then every `scanIntervalMinutes` from the start of each scan; a failed run is logged and the schedule continues; clean stop on Ctrl+C.
- **Client scan:** hand-written folder walk that skips symlinks and junctions; streamed SHA-256; KiB sizes; overlapping folders hashed once; one retry pass for files and folders; all six error codes.
- **Client snapshot DB:** fresh file per scan in one transaction; unfinished DB deleted on failure.
- **Client retention:** only the 2 newest snapshots are kept.
- **Client logging:** console plus log file.
- **Tests:** 39 xUnit tests covering config, path normalization, hashing, error mapping, scanning, and retention.
- **Docs:** full specification in `docs/`, plus this README.

### To do

**Client**
- Upload the snapshot to the server (waiting on the secure API; see [`api-contract.md`](docs/api-contract.md)).
- Retry uploads with backoff on network errors, timeouts and 5xx only; refuse a non-HTTPS base URL.
- Run as a Windows Service / systemd service so it starts with the machine.

**Secure API** (teammates)
- HTTPS transport and per-client key or certificate auth.
- Tell the server which client is sending (claim `clientId`); portal login policy.

**Server**
- Per-client DBs and `index.db`, with `Data`, `Scans`, `Changes` tables and WAL mode.
- Upload endpoint: temp file, size limit, validation, per-client lock.
- Merge in one transaction: NEW / CHANGED / DELETED / ERROR, idempotent and ordered.
- Read-only portal endpoints and report generation (JSON / CSV).

**Web portal** (team)
- Design the UI/UX, then build login and reports.

**Tooling**
- Optional: GitHub Actions workflow running `dotnet build` and `dotnet test` on every pull request.

**Ideas for later** (not planned yet; see [`potential-features.md`](docs/potential-features.md))
- Warn about or skip configured folders that contain the client's own files (`outputDir`, log, app folder).

### Open questions

Full list: [`docs/open-questions.md`](docs/open-questions.md).

**Portal**
- What the UI/UX looks like and which reports are needed.
- Should some portal users see only some clients?
- Report history, size limits, or streaming large reports.

**API**
- Key vs. certificate, header names, and upload format (whole DB file vs. JSON rows).
- Who issues per-client credentials, and whether an unknown but authenticated client gets a DB automatically (current: yes).
- Upload retry policy and maximum upload size (placeholder 500 MB).

**Server**
- Keep raw uploaded DB files for an audit trail, or delete after merge (current: delete).
- Confirm that out-of-order uploads are rejected with 409.
- Whether the portal needs "deleted" vs. "superseded" without reading the `Changes` log (would need another column).
- How short scan intervals affect DB growth for large clients.

## Documentation

| File | What's in it |
|---|---|
| [`docs/overview.md`](docs/overview.md) | Purpose, parts, data flow, core decisions, glossary |
| [`docs/data-model.md`](docs/data-model.md) | Shared `Data` table, error codes, path normalization |
| [`docs/client-spec.md`](docs/client-spec.md) | Client config, schedule, scan, retention, upload |
| [`docs/client-pseudocode.md`](docs/client-pseudocode.md) | Client pseudocode |
| [`docs/server-spec.md`](docs/server-spec.md) | Server storage, upload handling, merge rule, portal endpoints |
| [`docs/server-pseudocode.md`](docs/server-pseudocode.md) | Server pseudocode |
| [`docs/api-contract.md`](docs/api-contract.md) | Client ↔ server contract (placeholders) |
| [`docs/dev-setup.md`](docs/dev-setup.md) | Team setup checklist |
| [`docs/open-questions.md`](docs/open-questions.md) | Undecided items |
| [`docs/potential-features.md`](docs/potential-features.md) | Ideas for later |
| [`CLAUDE.md`](CLAUDE.md) | Instructions for Claude Code |
