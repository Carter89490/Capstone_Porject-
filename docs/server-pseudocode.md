# File Integrity Monitor: Server Pseudocode

Follows `CLAUDE.md` and the specs in `docs/` and matches `docs/client-pseudocode.md`. Target: C# / .NET 10 (LTS), ASP.NET Core (minimal APIs), Microsoft.Data.Sqlite, async I/O.
Scope: receiving client uploads, storing and merging them, and the HTTP endpoints the web portal calls for data and reports. Hosting the portal itself (pages, login UI) is out of scope.

Markers:
- `TODO(open-question)`: the team hasn't decided this.
- `API_PLACEHOLDER`: the API team owns this (auth, routes, payload shapes).
- `ASSUMPTION(portal-pending)`: a guess made because the portal UI/UX isn't designed yet. These endpoints are deliberately generic.

## Design choices made here (not in the brief, easy to change)

- **One server-only `active` column on `Data` (decided by Sam, 2026-10-19).** Each per-client DB has the same `Data` table as the client plus `active INTEGER`: `1` = current hash for that path, `0` = old (superseded, or the file was deleted). The client schema doesn't change. Why a row went inactive is in the `Changes` log. See section 3.
- **Error rows are always stored, always inactive (decided by Sam, 2026-10-19).** When the client can't hash a file after two tries, it sends a fixed error code (`LOCKED`, `PERMISSION_DENIED`, `NOT_FOUND`, `UNREADABLE`) in `hash`. A folder it can't open is sent the same way, with the folder's path and `DIR_UNREADABLE` (or `DIR_NOT_FOUND` for a missing root); files the server already knows under that folder keep their active rows instead of being reported deleted. The server adds every such row with `active = 0`, logs an `ERROR` change so reports show the attempt, and leaves the file's last good row active. A failed read is never reported as changed or deleted.
- **The databases only change when a client DB upload arrives (decided by Sam, 2026-10-19).** Every write to the index and the per-client DBs happens inside `HandleUploadScan` (sections 4 to 6). There are no timers or background jobs, and the portal endpoints only read: they open client DBs read-only and reports are built on demand, never stored.
- **Every merge writes a `Changes` log.** New, changed, and deleted files are recorded per scan, so reports are a simple query instead of re-diffing history every time.
- **Client ID comes only from authentication (decided by Sam, 2026-10-19).** Rows no longer carry a client ID, and the upload has no `clientId` field. The API tells the server which client is sending, and that decides which per-client DB the upload goes into, so one client can't write into another's DB. The old `clientId` column is replaced by `fileSize` (KiB, rounded up).
- **One upload at a time per client.** A per-client lock prevents two uploads from merging into the same DB at once.
- **Uploaded DB files are untrusted.** Size limit, opened read-only, schema and integrity checked, only the `Data` table is read.

---

## 1. Config

```
// server-config.json (example)
{
  "dataDir":        "/var/lib/fim/clients",       // one <clientId>.db per client lives here
  "indexDbPath":    "/var/lib/fim/index.db",      // index of known clients + upload history
  "tempDir":        "/var/lib/fim/incoming",      // uploads land here before validation
  "maxUploadBytes": 524288000,                    // 500 MB. TODO(open-question): real limit depends on client file counts
  "logPath":        "/var/log/fim/server.log",
  "api": {                                        // API_PLACEHOLDER: fields the API team defines
    "httpsCertPath":       "/etc/fim/server.pfx",
    "httpsCertPasswordEnv": "FIM_CERT_PASSWORD",  // secrets from env / OS store, never hard-coded
    "clientAuthMode":      "apiKey"               // or "clientCert"
  },
  "portal": {                                     // API_PLACEHOLDER / ASSUMPTION(portal-pending)
    "allowedOrigin": "https://fim-portal.example.edu",
    "authMode":      "cookie"
  }
}

RECORD ServerConfig
    dataDir, indexDbPath, tempDir, logPath : string
    maxUploadBytes                         : long
    api                                    : ApiServerSettings     // API_PLACEHOLDER
    portal                                 : PortalSettings        // API_PLACEHOLDER

FUNCTION LoadServerConfig(path) -> ServerConfig
    IF NOT FileExists(path) THEN FAIL "Config not found: " + path
    config = JsonDeserialize<ServerConfig>(ReadAllText(path))
    EnsureDirectoryExists(config.dataDir)
    EnsureDirectoryExists(config.tempDir)
    RETURN config
```

## 2. Entry point and routes

```
FUNCTION Main(args)
    config  = LoadServerConfig(args[0] OR "server-config.json")
    builder = WebApplication.CreateBuilder(args)

    // HTTPS only. API_PLACEHOLDER: the API team decides cert source and client-cert settings.
    builder.WebHost.ConfigureKestrel(k =>
        k.ListenAnyIP(443, l => l.UseHttps(LoadCertificate(config.api)))
        k.Limits.MaxRequestBodySize = config.maxUploadBytes)

    builder.Services.AddSingleton(config)
    builder.Services.AddSingleton<ClientIndex>()             // section 3
    builder.Services.AddSingleton<ClientLocks>()             // section 5
    AddClientAuthentication(builder.Services, config.api)    // API_PLACEHOLDER, section 9
    AddPortalAuthentication(builder.Services, config.portal) // API_PLACEHOLDER, section 9
    builder.Services.AddCors(o => o.AllowOnly(config.portal.allowedOrigin))

    app = builder.Build()
    app.UseHttpsRedirection()   // or reject plain HTTP outright
    app.UseAuthentication()
    app.UseAuthorization()
    AWAIT app.Services.Get<ClientIndex>().InitializeAsync()

    // ---- Client-facing (called by the client app) ----
    app.MapPost("/api/v1/scans", HandleUploadScan)                           // API_PLACEHOLDER route, matches client
        .RequireAuthorization("ClientPolicy")

    // ---- Portal-facing (called by the web portal). ASSUMPTION(portal-pending) ----
    portal = app.MapGroup("/api/v1/portal").RequireAuthorization("PortalUserPolicy")
    portal.MapGet ("/clients",                              GetClients)
    portal.MapGet ("/clients/{clientId}",                   GetClientSummary)
    portal.MapGet ("/clients/{clientId}/scans",             GetScans)
    portal.MapGet ("/clients/{clientId}/scans/{scanId}/changes", GetScanChanges)
    portal.MapGet ("/clients/{clientId}/files",             GetCurrentFiles)
    portal.MapGet ("/clients/{clientId}/files/history",     GetFileHistory)
    portal.MapPost("/reports",                              GenerateReport)

    AWAIT app.RunAsync()
```

## 3. Storage: client index and per-client databases

```
// ---------- index.db: one per server ----------
EXECUTE indexConn:
    CREATE TABLE IF NOT EXISTS Clients (
        clientId          TEXT PRIMARY KEY,
        dbFile            TEXT NOT NULL,        -- file name inside dataDir, e.g. "lab-pc-07.db"
        firstSeen         INTEGER NOT NULL,     -- Unix seconds
        lastUploadAt      INTEGER,              -- when the server received the latest upload
        lastScanStartedAt INTEGER               -- client's scanStartedAt of the latest merged upload
    );

// ---------- <clientId>.db: one per client ----------
EXECUTE clientConn:
    -- Shared columns, identical to the client schema
    CREATE TABLE IF NOT EXISTS Data (
        Key      INTEGER PRIMARY KEY,           -- server's own key; the client's Key is ignored
        fileSize INTEGER,                       -- KiB, rounded up; NULL on error rows with no size
        filePath TEXT    NOT NULL,
        hash     TEXT    NOT NULL,
        hashDate INTEGER NOT NULL,
        -- Server-only column (decided): 1 = active/current, 0 = old (superseded, file deleted, or an error row)
        active   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    -- At most one active row per path.
    CREATE UNIQUE INDEX IF NOT EXISTS IX_Data_ActivePath
        ON Data(filePath) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS IX_Data_Path ON Data(filePath);

    CREATE TABLE IF NOT EXISTS Scans (
        scanId        INTEGER PRIMARY KEY,
        scanStartedAt INTEGER NOT NULL UNIQUE,  -- from the client; also the idempotency key
        receivedAt    INTEGER NOT NULL,
        fileCount     INTEGER NOT NULL,
        newCount      INTEGER NOT NULL,
        changedCount  INTEGER NOT NULL,
        deletedCount  INTEGER NOT NULL,
        unchangedCount INTEGER NOT NULL,
        errorCount    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Changes (
        changeId   INTEGER PRIMARY KEY,
        scanId     INTEGER NOT NULL REFERENCES Scans(scanId),
        changeType TEXT    NOT NULL,            -- 'NEW' | 'CHANGED' | 'DELETED' | 'ERROR'
        filePath   TEXT    NOT NULL,
        oldKey     INTEGER,                     -- Data.Key before (CHANGED, DELETED)
        newKey     INTEGER,                     -- Data.Key after (NEW, CHANGED)
        oldHash    TEXT,
        newHash    TEXT
    );
    CREATE INDEX IF NOT EXISTS IX_Changes_Scan ON Changes(scanId);
    CREATE INDEX IF NOT EXISTS IX_Changes_Path ON Changes(filePath);   -- file history lookups

CLASS ClientIndex
    FUNCTION InitializeAsync()
        create index.db tables above      // schema only (IF NOT EXISTS); no data is written at startup
        PRAGMA journal_mode = WAL          // portal reads don't block upload writes

    // Returns the open connection to this client's DB, creating it the first time we see the ID.
    FUNCTION GetOrCreateClientDb(clientId) -> SqliteConnection
        RequireValidClientId(clientId)
        row = QUERY indexConn "SELECT dbFile FROM Clients WHERE clientId = $id"
        IF row IS NULL THEN
            dbFile = clientId + ".db"
            EXECUTE indexConn
                "INSERT INTO Clients (clientId, dbFile, firstSeen) VALUES ($id, $file, $now)"
            log.Info("New client registered in index: " + clientId)
        ELSE
            dbFile = row.dbFile
        conn = Open("Data Source=" + Combine(config.dataDir, dbFile))
        create per-client tables above (IF NOT EXISTS)
        PRAGMA journal_mode = WAL
        RETURN conn

    FUNCTION OpenExistingClientDb(clientId) -> SqliteConnection OR NULL   // for portal reads
        RequireValidClientId(clientId)
        row = QUERY indexConn "SELECT dbFile FROM Clients WHERE clientId = $id"
        IF row IS NULL THEN RETURN NULL
        RETURN Open("Data Source=" + Combine(config.dataDir, row.dbFile) + ";Mode=ReadOnly")

// clientId becomes a file name, so lock it down to prevent path traversal ("../x")
FUNCTION RequireValidClientId(clientId)
    IF NOT Regex.IsMatch(clientId, "^[A-Za-z0-9._-]{1,64}$") OR clientId IN (".", "..") THEN
        FAIL BadRequest("Invalid clientId")
```

## 4. Upload endpoint (client → server)

```
// POST /api/v1/scans   multipart: scanStartedAt, scanDb (file)
// API_PLACEHOLDER: route, field names and response shape must match the API team's contract
// and client-pseudocode.md section 6.

FUNCTION HandleUploadScan(HttpRequest request, user) -> IResult
    // The only source of the client ID: whoever the API authenticated
    clientId      = GetAuthenticatedClientId(user)          // API_PLACEHOLDER, section 9
    RequireValidClientId(clientId)
    form          = AWAIT request.ReadFormAsync()
    scanStartedAt = ParseLong(form["scanStartedAt"])
    file          = form.Files["scanDb"]

    IF file IS NULL OR scanStartedAt IS NULL THEN
        RETURN 400 "scanStartedAt and scanDb are required"

    // Save to a temp file the server names itself; never use the uploaded file name
    tempPath = Combine(config.tempDir, NewGuid() + ".db")
    TRY
        AWAIT CopyToFile(file.OpenReadStream(), tempPath)
        upload = AWAIT ReadAndValidateUpload(tempPath)
        IF upload.Error IS SET THEN RETURN 400 upload.Error

        lock = ClientLocks.For(clientId)
        AWAIT lock.WaitAsync()
        TRY
            conn   = ClientIndex.GetOrCreateClientDb(clientId)
            result = AWAIT MergeUpload(conn, scanStartedAt, upload.rows)
            UpdateIndexAfterUpload(clientId, scanStartedAt)
        FINALLY
            lock.Release()

        log.Info(clientId + " scan " + scanStartedAt + ": " + result.Summary())
        RETURN 200 Json(result)                              // API_PLACEHOLDER response shape
    CATCH OutOfOrderScan
        RETURN 409 "An equal or newer scan was already merged for this client"
    FINALLY
        DeleteIfExists(tempPath)
        // TODO(open-question): keep raw uploads for audit? If yes, move instead of delete.
```

## 5. Validating the uploaded DB

```
RECORD UploadRow   { filePath : string, fileSize : long OR NULL, hash : string, hashDate : long }
RECORD UploadData  { rows : list<UploadRow>, Error : string }

FUNCTION ReadAndValidateUpload(tempPath) -> UploadData
    // Untrusted file: read-only, no shared cache, only touch the Data table
    conn = Open("Data Source=" + tempPath + ";Mode=ReadOnly;Pooling=False")
    TRY
        IF QUERY conn "PRAGMA quick_check" != "ok" THEN
            RETURN Error("Uploaded DB is corrupt")
        cols = QUERY conn "PRAGMA table_info(Data)"
        IF cols does not contain Key, fileSize, filePath, hash, hashDate THEN
            RETURN Error("Uploaded DB does not match the shared schema")

        rows   = new Dictionary<string, UploadRow>()          // keyed by filePath
        reader = QUERY conn "SELECT fileSize, filePath, hash, hashDate FROM Data"
        FOR EACH r IN reader
            // A whole number of KiB, >= 0. NULL is allowed only on error rows.
            IF r.fileSize IS NULL AND NOT IsError(r.hash) THEN
                RETURN Error("Missing fileSize for " + r.filePath)
            IF r.fileSize IS NOT NULL AND (NOT IsInteger(r.fileSize) OR r.fileSize < 0) THEN
                RETURN Error("Bad fileSize for " + r.filePath)
            // A real SHA-256 (64 lowercase hex) or one of the shared error codes, nothing else
            IF NOT Regex.IsMatch(r.hash, "^[0-9a-f]{64}$") AND r.hash NOT IN HashError.All THEN
                RETURN Error("Bad hash for " + r.filePath)
            IF IsBlank(r.filePath) THEN RETURN Error("Empty filePath")
            // Client already de-duplicates, but if a path repeats keep the latest real hash
            // (a real hash beats an error code for the same path)
            IF NOT rows.ContainsKey(r.filePath)
               OR (IsError(rows[r.filePath].hash) AND NOT IsError(r.hash))
               OR (IsError(rows[r.filePath].hash) == IsError(r.hash) AND r.hashDate > rows[r.filePath].hashDate) THEN
                rows[r.filePath] = UploadRow(r.filePath, r.fileSize, r.hash, r.hashDate)
        RETURN UploadData(rows.Values)
    FINALLY
        conn.Close()

// Same list as the client's HashError enum (client-pseudocode.md section 4)
ENUM HashError { LOCKED, PERMISSION_DENIED, NOT_FOUND, UNREADABLE, DIR_UNREADABLE, DIR_NOT_FOUND }
FUNCTION IsError(hash) -> bool
    RETURN hash IN HashError.All
FUNCTION IsFolderError(hash) -> bool
    RETURN hash IN (DIR_UNREADABLE, DIR_NOT_FOUND)

// True if path is inside folder. Both are normalized the same way by the client
// ("/" separators, lowercase on Windows), so a prefix check is enough.
FUNCTION IsUnder(path, folder) -> bool
    prefix = folder.EndsWith("/") ? folder : folder + "/"     // "C:/" is already a prefix
    RETURN path.StartsWith(prefix, StringComparison.Ordinal)

CLASS ClientLocks
    locks = ConcurrentDictionary<string, SemaphoreSlim>()
    FUNCTION For(clientId) -> SemaphoreSlim
        RETURN locks.GetOrAdd(clientId, _ => new SemaphoreSlim(1, 1))
    // Single server process assumed. Several instances would need a DB-level lock instead.
```

## 6. Merge rule

```
RECORD MergeResult
    scanId, fileCount, newCount, changedCount, deletedCount, unchangedCount, errorCount : int

FUNCTION MergeUpload(conn, scanStartedAt, uploadRows) -> MergeResult
    // Idempotency: the client retries uploads, so the same scan may arrive twice
    existing = QUERY conn "SELECT * FROM Scans WHERE scanStartedAt = $s"
    IF existing IS NOT NULL THEN RETURN MergeResult.From(existing)

    // Ordering: an older snapshot arriving late would wrongly "delete" and "re-add" files
    latest = QUERY conn "SELECT MAX(scanStartedAt) FROM Scans"
    IF latest IS NOT NULL AND scanStartedAt < latest THEN THROW OutOfOrderScan

    now = UnixTimeSecondsNow()
    tx  = conn.BeginTransaction()                      // whole merge is all-or-nothing

    scanId = INSERT INTO Scans (scanStartedAt, receivedAt, fileCount, newCount, changedCount,
                                deletedCount, unchangedCount, errorCount)
             VALUES ($s, $now, $count, 0, 0, 0, 0, 0) RETURNING scanId

    // Current server state: path -> (Key, hash)
    current = QUERY conn
        "SELECT Key, filePath, hash FROM Data WHERE active = 1"
        INTO Dictionary<string, (Key, hash)>

    result = new MergeResult { scanId, fileCount = uploadRows.Count }
    unreadableFolders = new List<string>()             // folders the client couldn't open this scan

    FOR EACH row IN uploadRows
        IF IsError(row.hash) THEN
            // RULE: client couldn't hash the file -> always store the attempt, always inactive.
            // The last good row (if any) stays active: we don't know the file changed or went away.
            current.Remove(row.filePath)                 // so it isn't reported as deleted below
            IF IsFolderError(row.hash) THEN unreadableFolders.Add(row.filePath)
            errKey = InsertDataRow(conn, tx, row, active: 0)
            InsertChange(tx, scanId, "ERROR", row.filePath, NULL, errKey, NULL, row.hash)
            result.errorCount += 1
            CONTINUE

        IF current.TryGet(row.filePath) AS old THEN
            current.Remove(row.filePath)                 // seen in this scan; what's left is deleted
            IF old.hash == row.hash THEN
                result.unchangedCount += 1               // RULE: same path + same hash -> skip
                                                         // (only the hash is compared; fileSize is informational)
                CONTINUE
            // RULE: same path, different hash -> new row, old row superseded (history kept)
            // Deactivate the old row first so the "one active row per path" index never sees two
            EXECUTE "UPDATE Data SET active = 0 WHERE Key = $oldKey"
            newKey = InsertDataRow(conn, tx, row, active: 1)
            InsertChange(tx, scanId, "CHANGED", row.filePath, old.Key, newKey, old.hash, row.hash)
            result.changedCount += 1
        ELSE
            // RULE: path not current on the server -> new file
            // (Includes a file that was deleted earlier and has come back; its old rows stay as history.)
            newKey = InsertDataRow(conn, tx, row, active: 1)
            InsertChange(tx, scanId, "NEW", row.filePath, NULL, newKey, NULL, row.hash)
            result.newCount += 1

    // RULE: current on the server but missing from the upload -> deleted
    // (Locked / unreadable files arrive as error rows above, so they don't land here.)
    FOR EACH (path, old) IN current
        // Inside a folder the client couldn't open: unknown, not deleted. Keep the active row;
        // the folder's ERROR change already tells reports why these files weren't checked.
        IF ANY folder IN unreadableFolders WHERE IsUnder(path, folder) THEN CONTINUE
        EXECUTE "UPDATE Data SET active = 0 WHERE Key = $oldKey"     // the DELETED change below records why
        InsertChange(tx, scanId, "DELETED", path, old.Key, NULL, old.hash, NULL)
        result.deletedCount += 1

    EXECUTE "UPDATE Scans SET newCount=$n, changedCount=$c, deletedCount=$d, unchangedCount=$u,
             errorCount=$e WHERE scanId = $scanId"
    tx.Commit()
    RETURN result

FUNCTION InsertDataRow(conn, tx, row, active) -> long
    // Parameterized SQL only. hashDate is the client's time the hash (or attempt) was taken.
    // active is 1 for a real hash, always 0 for an error row. The row's scan is in the Changes log.
    RETURN EXECUTE
        "INSERT INTO Data (fileSize, filePath, hash, hashDate, active)
         VALUES ($size, $path, $hash, $date, $active) RETURNING Key"

FUNCTION InsertChange(tx, scanId, type, path, oldKey, newKey, oldHash, newHash)
    EXECUTE "INSERT INTO Changes (scanId, changeType, filePath, oldKey, newKey, oldHash, newHash)
             VALUES ($scan, $type, $path, $oldKey, $newKey, $oldHash, $newHash)"

FUNCTION UpdateIndexAfterUpload(clientId, scanStartedAt)
    EXECUTE indexConn
        "UPDATE Clients SET lastUploadAt = $now, lastScanStartedAt = $s WHERE clientId = $id"
```

## 7. Portal data endpoints (server → web portal)

```
// ASSUMPTION(portal-pending): the portal design will decide which of these are needed and
// what extra fields it wants. All return JSON and all are read-only, /reports included (it's a POST
// only so the filters fit in a body). Nothing here writes to any database,
// all list endpoints are paged (?page=1&pageSize=100, pageSize capped at 1000).
// Every handler: RequireValidClientId, then OpenExistingClientDb -> 404 if NULL.

// GET /api/v1/portal/clients
FUNCTION GetClients() -> IResult
    RETURN Json( QUERY indexConn
        "SELECT clientId, firstSeen, lastUploadAt, lastScanStartedAt FROM Clients ORDER BY clientId" )

// GET /api/v1/portal/clients/{clientId}
// Dashboard-style summary: current file count and what the latest scan found
FUNCTION GetClientSummary(clientId) -> IResult
    conn = OpenExistingClientDb(clientId) OR RETURN 404
    RETURN Json({
        clientId,
        currentFileCount: QUERY "SELECT COUNT(*) FROM Data WHERE active = 1",
        latestScan:       QUERY "SELECT * FROM Scans ORDER BY scanStartedAt DESC LIMIT 1",
        totalScans:       QUERY "SELECT COUNT(*) FROM Scans"
    })

// GET /api/v1/portal/clients/{clientId}/scans?from=&to=
FUNCTION GetScans(clientId, from, to, page) -> IResult
    RETURN Json( QUERY "SELECT * FROM Scans
                        WHERE ($from IS NULL OR scanStartedAt >= $from)
                          AND ($to   IS NULL OR scanStartedAt <= $to)
                        ORDER BY scanStartedAt DESC LIMIT $size OFFSET $offset" )

// GET /api/v1/portal/clients/{clientId}/scans/{scanId}/changes?type=NEW|CHANGED|DELETED
FUNCTION GetScanChanges(clientId, scanId, type, page) -> IResult
    RETURN Json( QUERY "SELECT changeType, filePath, oldHash, newHash FROM Changes
                        WHERE scanId = $scanId AND ($type IS NULL OR changeType = $type)
                        ORDER BY filePath LIMIT $size OFFSET $offset" )

// GET /api/v1/portal/clients/{clientId}/files?pathPrefix=&includeInactive=false
// Active rows only by default; includeInactive=true also returns old (active = 0) rows
FUNCTION GetCurrentFiles(clientId, pathPrefix, includeInactive, page) -> IResult
    // Prefix match with LIKE: escape % and _ in pathPrefix first, use ESCAPE '\'
    RETURN Json( QUERY "SELECT filePath, fileSize, hash, hashDate, active FROM Data
                        WHERE ($includeInactive = 1 OR active = 1)
                          AND ($prefix IS NULL OR filePath LIKE $prefix || '%' ESCAPE '\')
                        ORDER BY filePath LIMIT $size OFFSET $offset" )

// GET /api/v1/portal/clients/{clientId}/files/history?path=
// A single file's full timeline, oldest first: every NEW, CHANGED, DELETED and ERROR event,
// so it shows exactly when the file was tampered with, removed, or couldn't be read.
FUNCTION GetFileHistory(clientId, path) -> IResult
    // Built from the Changes log, one row per event, so each event appears exactly once.
    // (Joining Data to Changes on newKey alone would drop DELETED events, which have no newKey.)
    // The joined Data row is the one the event is about: the new row for NEW / CHANGED / ERROR,
    // the removed row for DELETED. Includes inactive rows: this is the "all past hashes" report.
    RETURN Json( QUERY "SELECT s.scanStartedAt, c.changeType, c.oldHash, c.newHash,
                               d.Key, d.fileSize, d.hashDate, d.active
                        FROM Changes c
                        JOIN Scans s     ON s.scanId = c.scanId
                        LEFT JOIN Data d ON d.Key = COALESCE(c.newKey, c.oldKey)
                        WHERE c.filePath = $path
                        ORDER BY s.scanStartedAt, c.changeId" )
```

## 8. Report generation (requested by the portal)

```
// POST /api/v1/portal/reports
// Body (ASSUMPTION(portal-pending)):
// {
//   "clientIds":   ["lab-pc-07", "lab-pc-08"],   // empty = all clients
//   "from":        1760000000,                    // Unix seconds, on scan time
//   "to":          1760900000,
//   "changeTypes": ["CHANGED", "NEW", "DELETED", "ERROR"], // empty = all
//   "format":      "json"                         // "json" | "csv"
// }

RECORD ReportRequest { clientIds, from, to, changeTypes, format }
RECORD ReportLine    { clientId, scanId, scanStartedAt, changeType, filePath, oldHash, newHash }

FUNCTION GenerateReport(ReportRequest req, user) -> IResult
    IF req.from > req.to THEN RETURN 400 "from must be before to"
    clientIds = req.clientIds IS EMPTY
                ? QUERY indexConn "SELECT clientId FROM Clients"
                : req.clientIds
    // TODO(open-question): should some portal users only see some clients? If yes, filter here.

    lines   = new List<ReportLine>()
    totals  = new Dictionary<string, Counts>()
    FOR EACH id IN clientIds
        conn = OpenExistingClientDb(id)
        IF conn IS NULL THEN CONTINUE                  // unknown ID: skip, list it in "missing"
        rows = QUERY conn
            "SELECT s.scanId, s.scanStartedAt, c.changeType, c.filePath, c.oldHash, c.newHash
             FROM Changes c JOIN Scans s ON s.scanId = c.scanId
             WHERE s.scanStartedAt BETWEEN $from AND $to
               AND c.changeType IN (<one parameter per requested type>)
             ORDER BY s.scanStartedAt, c.filePath"
        lines.AddRange(rows WITH clientId = id)
        totals[id] = CountByType(rows)
        // TODO(open-question): cap report size, or stream it, for very large clients

    report = { generatedAt: UnixTimeSecondsNow(), generatedBy: user.Name,
               request: req, totals, lines }

    IF req.format == "csv" THEN
        RETURN File(ToCsv(lines), "text/csv", "fim-report-" + report.generatedAt + ".csv")
    RETURN Json(report)
    // Built on demand and returned, never saved: the server DBs only change on a client upload.
```

## 9. Authentication hooks (API placeholders)

```
// Everything here is the API team's. The server only needs two answers:
//   1. For client calls: which clientId is this request? (or reject)
//   2. For portal calls: is this a logged-in portal user? (or reject)

FUNCTION AddClientAuthentication(services, apiSettings)       // API_PLACEHOLDER
    IF apiSettings.clientAuthMode == "clientCert" THEN
        // Kestrel ClientCertificateMode.RequireCertificate; map cert subject/thumbprint -> clientId
        services.AddAuthentication().AddCertificate(...)
    ELSE
        // Per-client API key in a header, looked up as a SALTED HASH, never stored in plain text
        services.AddAuthentication().AddScheme<ApiKeyHandler>("ApiKey")
    services.AddAuthorization(o => o.AddPolicy("ClientPolicy", requires claim "clientId"))

FUNCTION GetAuthenticatedClientId(user) -> string              // API_PLACEHOLDER
    RETURN user.FindFirst("clientId").Value

FUNCTION AddPortalAuthentication(services, portalSettings)    // API_PLACEHOLDER
    // The portal handles login; this API only checks the resulting session or token.
    // e.g. cookie auth shared with the portal, or a bearer token the portal sends.
    services.AddAuthorization(o => o.AddPolicy("PortalUserPolicy", requires authenticated portal user))

// TODO(open-question): how a new client gets its key/cert. Today a client ID the server hasn't
// seen gets a new DB on its first upload, but only after the API has authenticated it, so
// "registering" a client really means issuing it a credential.
```

---

## Open questions this pseudocode surfaces

- **Deleted vs. superseded.** Both set `active = 0`; the `Changes` log says which. If the portal needs to tell them apart without the log, that would take another column.
- **Out-of-order uploads** are rejected with 409. Fine if the client uploads each scan right after it, but the team should confirm.
- **Client registration.** Who issues per-client keys/certs, and whether an unknown-but-authenticated client should get a DB automatically (current behavior).
- **Portal data needs.** Endpoints in sections 7 and 8 are generic guesses until the UI/UX is designed. Per-user client visibility, report history, and report size limits are all open.
- **Raw upload retention.** Uploaded DB files are deleted after merge; keep them if the team wants an audit trail.
- **Scan interval** is set per client in its config (`scanIntervalMinutes`). Short intervals on large clients mean more uploads and faster growth of `Changes` and error rows; worth checking once real file counts are known.
