# FileGuard: Server Pseudocode

Follows `CLAUDE.md` and the specs in `docs/` and matches `docs/client-pseudocode.md`. Target: C# / .NET 10 (LTS), ASP.NET Core (minimal APIs), Microsoft.Data.Sqlite, async I/O.
Routes, payloads, status codes and auth are defined in `api-contract.md`; this file shows how the server implements them.

Markers:
- `TODO(open-question)`: the team hasn't decided this (see `open-questions.md`).
- `ASSUMPTION(portal-pending)`: a portal detail beyond the agreed prototype (`web-portal-prototype.md`).

## Design choices made here

- **One server-only `active` column on `Data` (decided by Sam, 2026-10-19).** Each per-client DB has the same `Data` table as the client plus `active INTEGER`: `1` = current hash for that path, `0` = old (superseded, or the file was deleted). Why a row went inactive is in the `Changes` log. See section 3.
- **Error rows are always inactive (decided by Sam, 2026-10-19) and stored only when an error starts or changes (decided by Sam, 2026-11-12).** A file the client couldn't hash arrives with an error code in `hash`; a folder it couldn't open arrives with the folder's path and `DIR_UNREADABLE` (or `DIR_NOT_FOUND` for a missing root), and files the server already knows under it keep their active rows instead of being reported deleted. A new or different error is stored with `active = 0` and logged as an `ERROR` change; the same error on later scans only extends that change (`lastSeenScanId`, `seenCount`). The file's last good row stays active. A failed read is never reported as changed or deleted.
- **Per-client DBs only change when that client's upload arrives (decided by Sam, 2026-10-19).** `index.db` also changes on enrollment, admin actions and login attempts (decided by Sam, 2026-11-11). No timers or background jobs; portal reads open DBs read-only; reports are built on demand, never stored.
- **Every merge writes a `Changes` log and a `Scans` row.** New, changed, deleted and error events are recorded per scan, so reports, the tree badges and the trends chart are simple queries.
- **Client ID comes only from the API key (decided by Sam, 2026-10-19).** The key decides which per-client DB the upload goes into.
- **Scan metadata travels with the upload (decided by Sam, 2026-11-11).** Only what the server can't derive: start/finish times, folders scanned, and the agent's details. Everything else is counted from the snapshot or the merge.
- **Agents are enrolled, not auto-registered (decided by Sam, 2026-11-11).** Deploy new agent creates the client and a one-time enrollment token; the client swaps the token for its API key.
- **Removed folders are "no longer monitored", not deleted (decided by Sam, 2026-11-12).** An active path outside every root the client now reports is set inactive and logged `UNMONITORED`.
- **Out-of-order scans are rejected, logged and raised as a portal alert (decided by Sam, 2026-11-12).**
- **The 2 newest raw uploads per client are kept (decided by Sam, 2026-11-12)**, older ones deleted on each upload, like the client's snapshot retention.
- **One upload at a time per client.** A per-client lock prevents two uploads merging into the same DB at once.
- **Uploaded DB files are untrusted.** Size limit, opened read-only, schema and integrity checked, only the `Data` table is read.

---

## 1. Config

```
// server-config.json (example; secrets come from env vars / dotnet user-secrets)
{
  "dataDir":                    "C:\\FileGuardServer\\clients",   // one <clientId>.db per client
  "indexDbPath":                "C:\\FileGuardServer\\index.db",  // clients, keys, tokens, users, alerts, audit log
  "tempDir":                    "C:\\FileGuardServer\\incoming",  // uploads land here before validation
  "uploadsDir":                 "C:\\FileGuardServer\\uploads",   // merged raw uploads: <clientId>/scan_<scanStartedAt>.db
  "rawUploadsToKeep":           2,                                 // newest merged uploads kept per client
  "logPath":                    "C:\\FileGuardServer\\server.log",
  "maxUploadBytes":             524288000,                         // 500 MiB
  "publicBaseUrl":              "https://fileguard.example.edu",   // written into generated client configs
  "tls": {
    "pfxPath":    "C:\\FileGuardServer\\tls\\server.pfx",          // created if missing; password: env FIM_CERT_PASSWORD
    "names":      [ "fileguard-server", "10.0.0.5" ],               // hostnames + IPs in the certificate
    "validYears": 2
  },
  "pinServerKey":               true,                              // put serverKeySha256 in client configs
  "enrollmentTokenHours":       24,
  "defaultScanIntervalMinutes": 360
}

RECORD ServerConfig
    dataDir, indexDbPath, tempDir, uploadsDir, logPath, publicBaseUrl : string
    tls                                                               : { pfxPath : string, names : list<string>, validYears : int }
    maxUploadBytes                                                    : long
    rawUploadsToKeep                                                  : int
    pinServerKey                                                      : bool
    enrollmentTokenHours, defaultScanIntervalMinutes                  : double

FUNCTION LoadServerConfig(path) -> ServerConfig
    IF NOT FileExists(path) THEN FAIL "Config not found: " + path
    config = JsonDeserialize<ServerConfig>(ReadAllText(path))
    IF NOT config.publicBaseUrl starts with "https://" THEN FAIL "publicBaseUrl must be HTTPS"
    EnsureDirectoryExists(config.dataDir)
    EnsureDirectoryExists(config.tempDir)
    EnsureDirectoryExists(config.uploadsDir)
    IF config.rawUploadsToKeep < 1 THEN FAIL "rawUploadsToKeep must be at least 1"
    RETURN config
```

## 2. Entry point and routes

```
FUNCTION Main(args)
    config  = LoadServerConfig(args[0] OR "server-config.json")
    builder = WebApplication.CreateBuilder(args)
    cert    = EnsureServerCertificate(config.tls, Env("FIM_CERT_PASSWORD"))   // section 11

    // HTTPS only, TLS 1.2+. No plain HTTP listener at all.
    builder.WebHost.ConfigureKestrel(k =>
        k.ListenAnyIP(443, l => l.UseHttps(cert, tls => tls.SslProtocols = Tls12 | Tls13))
        k.Limits.MaxRequestBodySize = config.maxUploadBytes)

    builder.Services.AddSingleton(config)
    builder.Services.AddSingleton(new ServerKeyPin(KeyPin(cert)))           // section 11
    builder.Services.AddSingleton<IndexDb>()                 // section 3
    builder.Services.AddSingleton<ClientLocks>()             // section 5
    builder.Services.AddAuthentication()
        .AddScheme<ApiKeyHandler>("ApiKey")                  // section 9
        .AddCookie("Portal", PortalCookieOptions)            // section 9
    builder.Services.AddAuthorization(o =>
        o.AddPolicy("Agent",  requires scheme "ApiKey" and claim "clientId")
        o.AddPolicy("Viewer", requires scheme "Portal" and role IN ("viewer", "admin"))
        o.AddPolicy("Admin",  requires scheme "Portal" and role == "admin"))
    builder.Services.AddAntiforgery(o => o.HeaderName = "X-CSRF-TOKEN")
    builder.Services.AddRateLimiter(o =>
        o.AddFixedWindow("enroll", 10 per minute per IP)
        o.AddFixedWindow("login",  20 per minute per IP))
    builder.Services.AddProblemDetails()                     // every error is application/problem+json

    app = builder.Build()
    app.UseHsts()
    app.UseDefaultFiles(); app.UseStaticFiles()              // the portal pages (Server/wwwroot)
    app.UseRateLimiter()
    app.UseAuthentication(); app.UseAuthorization()
    app.UseAntiforgery()                                     // checks X-CSRF-TOKEN on unsafe portal methods
    AWAIT app.Services.Get<IndexDb>().InitializeAsync()      // schema + first admin (section 9)

    // ---- Agent ----
    app.MapPost("/api/v1/agent/enroll", HandleEnroll).RequireRateLimiting("enroll")      // section 10
    app.MapPost("/api/v1/scans",        HandleUploadScan).RequireAuthorization("Agent")  // section 4

    // ---- Portal auth ----
    app.MapPost("/api/v1/auth/login",  HandleLogin).RequireRateLimiting("login")         // section 9
    app.MapPost("/api/v1/auth/logout", HandleLogout).RequireAuthorization("Viewer")
    app.MapGet ("/api/v1/auth/me",     HandleMe).RequireAuthorization("Viewer")

    // ---- Portal data (read-only) ----
    portal = app.MapGroup("/api/v1/portal").RequireAuthorization("Viewer")
    portal.MapGet ("/summary",                                GetSummary)          // section 7
    portal.MapGet ("/scans",                                  GetScans)
    portal.MapGet ("/clients",                                GetClients)
    portal.MapGet ("/clients/{clientId}",                     GetClient)
    portal.MapGet ("/clients/{clientId}/scans/{scanId}/changes", GetScanChanges)
    portal.MapGet ("/clients/{clientId}/tree",                GetTree)
    portal.MapGet ("/clients/{clientId}/file",                GetFile)
    portal.MapGet ("/clients/{clientId}/files",               GetFiles)
    portal.MapGet ("/trends",                                 GetTrends)
    portal.MapGet ("/alerts",                                 GetAlerts)
    portal.MapPost("/reports/export",                         ExportReport)        // section 8
    portal.MapPost("/reports/changes.csv",                    ExportChangesCsv)

    // ---- Admin ----
    admin = app.MapGroup("/api/v1/portal").RequireAuthorization("Admin")
    admin.MapPost ("/agents",                          DeployAgent)                // section 10
    admin.MapPost ("/clients/{clientId}/enrollment",   NewEnrollment)
    admin.MapPost ("/clients/{clientId}/revoke",       RevokeClient)
    admin.MapPatch("/clients/{clientId}",              EditClient)
    admin.MapPost ("/alerts/{alertId}/acknowledge",     AcknowledgeAlert)           // section 7
    admin.MapGet  ("/users",                           GetUsers)                   // section 9
    admin.MapPost ("/users",                           CreateUser)
    admin.MapPatch("/users/{username}",                EditUser)

    AWAIT app.RunAsync()
```

## 3. Storage: index.db and per-client databases

```
// ---------- index.db: one per server ----------
EXECUTE indexConn:
    CREATE TABLE IF NOT EXISTS Clients (
        clientId            TEXT PRIMARY KEY,
        displayName         TEXT NOT NULL,
        notes               TEXT,
        status              TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
        createdAt           INTEGER NOT NULL,
        createdBy           TEXT NOT NULL,          -- portal username
        enrolledAt          INTEGER,
        dbFile              TEXT NOT NULL,          -- file name inside dataDir, e.g. "ws-acct-01.db"
        -- Agent details, refreshed by enrollment and every upload
        hostname            TEXT,
        os                  TEXT,
        clientVersion       TEXT,
        scanIntervalMinutes REAL,
        directoriesJson     TEXT,                   -- JSON array of normalized roots
        firstUploadAt       INTEGER,
        lastUploadAt        INTEGER,                -- when the server received the latest upload
        lastScanStartedAt   INTEGER                 -- scanStartedAt of the latest merged upload
    );

    CREATE TABLE IF NOT EXISTS ApiKeys (
        keyId     TEXT PRIMARY KEY,                 -- the <keyId> part of fgk_<keyId>_<secret>
        clientId  TEXT NOT NULL REFERENCES Clients(clientId),
        salt      BLOB NOT NULL,                    -- 16 random bytes
        hash      BLOB NOT NULL,                    -- SHA-256(salt || secret)
        createdAt INTEGER NOT NULL,
        revokedAt INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS IX_ApiKeys_OneLive ON ApiKeys(clientId) WHERE revokedAt IS NULL;

    CREATE TABLE IF NOT EXISTS EnrollmentTokens (
        tokenId   TEXT PRIMARY KEY,                 -- the <tokenId> part of fge_<tokenId>_<secret>
        clientId  TEXT NOT NULL REFERENCES Clients(clientId),
        salt      BLOB NOT NULL,
        hash      BLOB NOT NULL,
        createdAt INTEGER NOT NULL,
        createdBy TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        usedAt    INTEGER,
        revokedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS PortalUsers (
        username     TEXT PRIMARY KEY,
        passwordHash TEXT NOT NULL,                 -- "pbkdf2-sha256$600000$<salt b64>$<hash b64>"
        role         TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        disabled     INTEGER NOT NULL DEFAULT 0,
        createdAt    INTEGER NOT NULL,
        lastLoginAt  INTEGER,
        failedLogins INTEGER NOT NULL DEFAULT 0,
        lockedUntil  INTEGER
    );

    CREATE TABLE IF NOT EXISTS AuditLog (
        eventId  INTEGER PRIMARY KEY,
        at       INTEGER NOT NULL,
        username TEXT,                              -- NULL for agent events
        action   TEXT NOT NULL,                     -- 'login_ok', 'login_failed', 'deploy_agent', 'enroll',
                                                    -- 'new_enrollment', 'revoke', 'edit_client', 'user_change', 'ack_alert'
        target   TEXT,                              -- clientId or username
        detail   TEXT,                              -- never secrets
        remoteIp TEXT
    );

    CREATE TABLE IF NOT EXISTS Alerts (
        alertId        INTEGER PRIMARY KEY,
        clientId       TEXT NOT NULL REFERENCES Clients(clientId),
        type           TEXT NOT NULL,             -- 'scan_out_of_order' (more types can be added)
        message        TEXT NOT NULL,
        firstAt        INTEGER NOT NULL,
        lastAt         INTEGER NOT NULL,
        count          INTEGER NOT NULL DEFAULT 1,
        acknowledgedAt INTEGER,
        acknowledgedBy TEXT
    );
    -- At most one open (unacknowledged) alert per client and type; repeats bump count / lastAt
    CREATE UNIQUE INDEX IF NOT EXISTS IX_Alerts_Open ON Alerts(clientId, type) WHERE acknowledgedAt IS NULL;

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
    CREATE UNIQUE INDEX IF NOT EXISTS IX_Data_ActivePath ON Data(filePath) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS IX_Data_Path ON Data(filePath);

    CREATE TABLE IF NOT EXISTS Scans (
        scanId         INTEGER PRIMARY KEY,
        scanStartedAt  INTEGER NOT NULL UNIQUE,  -- from metadata; idempotency + order key
        scanFinishedAt INTEGER NOT NULL,         -- from metadata
        receivedAt     INTEGER NOT NULL,
        foldersScanned INTEGER NOT NULL,         -- from metadata
        filesFound     INTEGER NOT NULL,         -- hashedCount + file error rows (counted by the server)
        hashedCount    INTEGER NOT NULL,         -- rows with a real hash
        errorCount     INTEGER NOT NULL,         -- error rows, files and folders
        newCount       INTEGER NOT NULL,         -- from the merge
        changedCount   INTEGER NOT NULL,
        deletedCount   INTEGER NOT NULL,
        unmonitoredCount INTEGER NOT NULL,       -- folder removed from the client's config
        unchangedCount INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Changes (
        changeId   INTEGER PRIMARY KEY,
        scanId     INTEGER NOT NULL REFERENCES Scans(scanId),
        changeType TEXT    NOT NULL CHECK (changeType IN ('NEW', 'CHANGED', 'DELETED', 'UNMONITORED', 'ERROR')),
        filePath   TEXT    NOT NULL,
        oldKey     INTEGER,                     -- Data.Key before (CHANGED, DELETED, UNMONITORED)
        newKey     INTEGER,                     -- Data.Key after (NEW, CHANGED, ERROR)
        oldHash    TEXT,
        newHash    TEXT,
        -- ERROR rows only: the error is stored once and extended while it repeats
        lastSeenScanId INTEGER REFERENCES Scans(scanId),   -- last scan the same error was seen in
        seenCount      INTEGER                             -- scans it lasted (1 = seen once)
    );
    CREATE INDEX IF NOT EXISTS IX_Changes_Scan ON Changes(scanId);
    CREATE INDEX IF NOT EXISTS IX_Changes_Path ON Changes(filePath);   -- file history lookups

    -- Errors still going on as of the latest scan: one per path
    CREATE TABLE IF NOT EXISTS OpenErrors (
        filePath TEXT PRIMARY KEY,
        changeId INTEGER NOT NULL REFERENCES Changes(changeId)
    );

CLASS IndexDb
    FUNCTION InitializeAsync()
        create index.db tables above (IF NOT EXISTS)
        PRAGMA journal_mode = WAL
        AWAIT EnsureFirstAdmin()                    // section 9

    // For uploads. The Clients row always exists (created by DeployAgent); the DB file
    // is created on the client's first upload.
    FUNCTION OpenClientDbForWrite(clientId) -> SqliteConnection
        RequireValidClientId(clientId)
        dbFile = QUERY "SELECT dbFile FROM Clients WHERE clientId = $id"
        conn = Open("Data Source=" + Combine(config.dataDir, dbFile))
        create per-client tables above (IF NOT EXISTS)
        PRAGMA journal_mode = WAL
        RETURN conn

    // For portal reads. NULL if the client is unknown; an empty result if it never uploaded.
    FUNCTION OpenClientDbReadOnly(clientId) -> SqliteConnection OR NULL OR EMPTY
        RequireValidClientId(clientId)
        row = QUERY "SELECT dbFile FROM Clients WHERE clientId = $id"
        IF row IS NULL THEN RETURN NULL
        path = Combine(config.dataDir, row.dbFile)
        IF NOT FileExists(path) THEN RETURN EMPTY   // pending client, or no upload yet
        RETURN Open("Data Source=" + path + ";Mode=ReadOnly")

// clientId becomes a file name, so lock it down to prevent path traversal ("../x")
FUNCTION RequireValidClientId(clientId)
    IF NOT Regex.IsMatch(clientId, "^[A-Za-z0-9._-]{1,64}$") OR clientId IN (".", "..") THEN
        FAIL 400 invalid_request
```

## 4. Upload endpoint (client → server)

```
// POST /api/v1/scans   Bearer API key; multipart: metadata (JSON), scanDb (file). See api-contract.md.

RECORD AgentInfo    { clientVersion, hostname, os : string; scanIntervalMinutes : double; directories : list<string> }
RECORD ScanMetadata { schemaVersion : int; scanStartedAt, scanFinishedAt : long; foldersScanned : int; agent : AgentInfo }

FUNCTION HandleUploadScan(HttpRequest request, user) -> IResult
    // The only source of the client ID: the API key (section 9)
    clientId = user.FindFirst("clientId").Value
    form     = AWAIT request.ReadFormAsync()               // MaxRequestBodySize -> 413 upload_too_large
    meta     = ParseMetadata(form["metadata"])             // NULL or invalid -> 400 invalid_metadata
    file     = form.Files["scanDb"]
    IF file IS NULL THEN RETURN Problem(400, "invalid_upload", "scanDb is required")

    // Save to a temp file the server names itself; never use the uploaded file name
    tempPath = Combine(config.tempDir, NewGuid() + ".db")
    kept     = false
    TRY
        AWAIT CopyToFile(file.OpenReadStream(), tempPath)
        upload = AWAIT ReadAndValidateUpload(tempPath)
        IF upload.Error IS SET THEN RETURN Problem(400, "invalid_upload", upload.Error)

        lock = ClientLocks.For(clientId)
        AWAIT lock.WaitAsync()
        TRY
            conn   = IndexDb.OpenClientDbForWrite(clientId)
            result = AWAIT MergeUpload(conn, meta, upload.rows)          // section 6
            IF NOT result.alreadyMerged THEN
                UpdateClientAfterUpload(clientId, meta)
                KeepRawUpload(clientId, meta.scanStartedAt, tempPath)    // moves the file
                kept = true
        FINALLY
            lock.Release()

        log.Info(clientId + " scan " + meta.scanStartedAt + ": " + result.Summary())
        RETURN 200 Json({ scanId: result.scanId, alreadyMerged: result.alreadyMerged, counts: result.counts })
    CATCH OutOfOrderScan AS e
        // Old data never overwrites newer data. Usually the client's clock went backwards.
        log.Warn(clientId + ": rejected out-of-order scan " + meta.scanStartedAt
                 + " (latest merged " + e.latestStartedAt + "); check the client's clock")
        RaiseAlert(clientId, "scan_out_of_order",
                   "Rejected a scan started at " + meta.scanStartedAt + "; the latest merged scan started at "
                   + e.latestStartedAt + ". Check the client's clock.")
        RETURN Problem(409, "scan_out_of_order", "An equal or newer scan was already merged for this client")
    FINALLY
        IF NOT kept THEN DeleteIfExists(tempPath)        // rejected uploads and repeats aren't kept

// Keep the newest rawUploadsToKeep merged uploads per client, like the client's snapshot retention
FUNCTION KeepRawUpload(clientId, scanStartedAt, tempPath)
    dir = Combine(config.uploadsDir, clientId)
    EnsureDirectoryExists(dir)
    Move(tempPath, Combine(dir, "scan_" + scanStartedAt + ".db"), overwrite: true)
    files = FilesIn(dir, "scan_*.db") SORTED DESCENDING BY the <scanStartedAt> in the name   // skip names that don't parse
    FOR EACH old IN files SKIP config.rawUploadsToKeep
        TRY DeleteFile(old)
        CATCH (IOException, UnauthorizedAccessException) AS e
            log.Warn("Could not delete old raw upload " + old + " : " + e.Message)   // never fails the upload

// One open alert per client and type; a repeat bumps its count instead of adding rows
FUNCTION RaiseAlert(clientId, type, message)
    EXECUTE indexConn
        "INSERT INTO Alerts (clientId, type, message, firstAt, lastAt, count) VALUES ($id, $type, $msg, $now, $now, 1)
         ON CONFLICT (clientId, type) WHERE acknowledgedAt IS NULL
         DO UPDATE SET lastAt = $now, count = count + 1, message = $msg"

FUNCTION ParseMetadata(json) -> ScanMetadata OR FAIL 400 invalid_metadata
    meta = JsonDeserialize<ScanMetadata>(json)
    REQUIRE meta.schemaVersion == 1
    REQUIRE meta.scanFinishedAt >= meta.scanStartedAt > 0
    REQUIRE meta.foldersScanned >= 0
    REQUIRE meta.agent.scanIntervalMinutes > 0
    REQUIRE 1 <= meta.agent.directories.Count <= 1000, none blank
    REQUIRE lengths: clientVersion <= 32, hostname <= 255, os <= 255
    RETURN meta

FUNCTION UpdateClientAfterUpload(clientId, meta)
    EXECUTE indexConn
        "UPDATE Clients SET hostname = $host, os = $os, clientVersion = $ver,
                scanIntervalMinutes = $interval, directoriesJson = $dirs,
                firstUploadAt = COALESCE(firstUploadAt, $now), lastUploadAt = $now,
                lastScanStartedAt = $started
         WHERE clientId = $id"
```

## 5. Validating the uploaded DB

```
RECORD UploadRow   { filePath : string, fileSize : long OR NULL, hash : string, hashDate : long }
RECORD UploadData  { rows : list<UploadRow>, Error : string }

FUNCTION ReadAndValidateUpload(tempPath) -> UploadData
    // Untrusted file: read-only, no pooling, only touch the Data table
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

// Same list as the client's HashError (client-pseudocode.md section 4)
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
RECORD Counts      { filesFound, hashed, errors, new, changed, deleted, unmonitored, unchanged : int }
RECORD MergeResult { scanId : long, alreadyMerged : bool, counts : Counts }

FUNCTION MergeUpload(conn, meta, uploadRows) -> MergeResult
    // Idempotency: the client retries uploads, so the same scan may arrive twice
    existing = QUERY conn "SELECT * FROM Scans WHERE scanStartedAt = $s"
    IF existing IS NOT NULL THEN RETURN MergeResult(existing.scanId, alreadyMerged: true, CountsFrom(existing))

    // Ordering: an older snapshot arriving late would wrongly "delete" and "re-add" files
    latest = QUERY conn "SELECT MAX(scanStartedAt) FROM Scans"
    IF latest IS NOT NULL AND meta.scanStartedAt < latest THEN THROW OutOfOrderScan(latestStartedAt: latest)

    tx = conn.BeginTransaction()                       // whole merge is all-or-nothing

    // Counted from the snapshot, not trusted from the client
    c = new Counts()
    c.hashed     = COUNT uploadRows WHERE NOT IsError(hash)
    c.errors     = COUNT uploadRows WHERE IsError(hash)
    c.filesFound = c.hashed + COUNT uploadRows WHERE IsError(hash) AND NOT IsFolderError(hash)

    scanId = INSERT INTO Scans (scanStartedAt, scanFinishedAt, receivedAt, foldersScanned,
                                filesFound, hashedCount, errorCount,
                                newCount, changedCount, deletedCount, unmonitoredCount, unchangedCount)
             VALUES ($started, $finished, $now, $folders, $found, $hashed, $errors, 0, 0, 0, 0, 0)
             RETURNING scanId

    // Current server state: path -> (Key, hash)
    current = QUERY conn "SELECT Key, filePath, hash FROM Data WHERE active = 1"
              INTO Dictionary<string, (Key, hash)>
    unreadableFolders = new List<string>()             // folders the client couldn't open this scan
    // Errors still going on after the previous scan: path -> (changeId, code)
    openErrors = QUERY conn "SELECT o.filePath, o.changeId, c.newHash FROM OpenErrors o
                             JOIN Changes c ON c.changeId = o.changeId"
                 INTO Dictionary<string, (changeId, code)>
    erroredNow = new HashSet<string>()                 // paths that arrived with an error this scan

    FOR EACH row IN uploadRows
        IF IsError(row.hash) THEN
            // RULE: the client couldn't hash it. The last good row (if any) stays active:
            // we don't know the file changed or went away.
            current.Remove(row.filePath)                 // so it isn't reported as deleted below
            IF IsFolderError(row.hash) THEN unreadableFolders.Add(row.filePath)
            erroredNow.Add(row.filePath)
            IF openErrors.TryGet(row.filePath) AS open AND open.code == row.hash THEN
                // RULE: same error as last scan -> store nothing new, extend the open error
                EXECUTE "UPDATE Changes SET lastSeenScanId = $scanId, seenCount = seenCount + 1
                         WHERE changeId = $open"
            ELSE
                // RULE: new or different error -> store it once, always inactive
                errKey   = InsertDataRow(tx, row, active: 0)
                changeId = InsertChange(tx, scanId, "ERROR", row.filePath, NULL, errKey, NULL, row.hash)
                EXECUTE "UPDATE Changes SET lastSeenScanId = $scanId, seenCount = 1 WHERE changeId = $changeId"
                EXECUTE "INSERT INTO OpenErrors (filePath, changeId) VALUES ($path, $changeId)
                         ON CONFLICT (filePath) DO UPDATE SET changeId = excluded.changeId"
            CONTINUE

        IF current.TryGet(row.filePath) AS old THEN
            current.Remove(row.filePath)                 // seen in this scan; what's left is deleted
            IF old.hash == row.hash THEN
                c.unchanged += 1                         // RULE: same path + same hash -> skip
                CONTINUE                                 // (only the hash is compared; fileSize is informational)
            // RULE: same path, different hash -> new row, old row superseded (history kept)
            // Deactivate the old row first so the "one active row per path" index never sees two
            EXECUTE "UPDATE Data SET active = 0 WHERE Key = $oldKey"
            newKey = InsertDataRow(tx, row, active: 1)
            InsertChange(tx, scanId, "CHANGED", row.filePath, old.Key, newKey, old.hash, row.hash)
            c.changed += 1
        ELSE
            // RULE: path not current on the server -> new file
            // (Includes a file that was deleted earlier and has come back; its old rows stay as history.)
            newKey = InsertDataRow(tx, row, active: 1)
            InsertChange(tx, scanId, "NEW", row.filePath, NULL, newKey, NULL, row.hash)
            c.new += 1

    // Current on the server but missing from the upload.
    // (Locked / unreadable files arrive as error rows above, so they don't land here.)
    FOR EACH (path, old) IN current
        // RULE: outside every root the client now monitors -> its folder was removed from the
        // config: no longer monitored, not deleted. If the folder comes back, its files are NEW again.
        IF NOT ANY root IN meta.agent.directories WHERE (path == root OR IsUnder(path, root)) THEN
            EXECUTE "UPDATE Data SET active = 0 WHERE Key = $oldKey"
            InsertChange(tx, scanId, "UNMONITORED", path, old.Key, NULL, old.hash, NULL)
            c.unmonitored += 1
            CONTINUE
        // Inside a folder the client couldn't open: unknown, not deleted. Keep the active row;
        // the folder's ERROR change already tells reports why these files weren't checked.
        IF ANY folder IN unreadableFolders WHERE IsUnder(path, folder) THEN CONTINUE
        // RULE: otherwise -> deleted
        EXECUTE "UPDATE Data SET active = 0 WHERE Key = $oldKey"
        InsertChange(tx, scanId, "DELETED", path, old.Key, NULL, old.hash, NULL)
        c.deleted += 1

    // Errors that didn't come back this scan have ended; their ERROR change keeps its range
    FOR EACH path IN openErrors.Keys WHERE path NOT IN erroredNow
        EXECUTE "DELETE FROM OpenErrors WHERE filePath = $path"

    EXECUTE "UPDATE Scans SET newCount=$n, changedCount=$c, deletedCount=$d, unmonitoredCount=$m,
             unchangedCount=$u WHERE scanId = $scanId"
    tx.Commit()
    RETURN MergeResult(scanId, alreadyMerged: false, c)

FUNCTION InsertDataRow(tx, row, active) -> long
    // Parameterized SQL only. hashDate is the client's time the hash (or attempt) was taken.
    RETURN EXECUTE
        "INSERT INTO Data (fileSize, filePath, hash, hashDate, active)
         VALUES ($size, $path, $hash, $date, $active) RETURNING Key"

FUNCTION InsertChange(tx, scanId, type, path, oldKey, newKey, oldHash, newHash) -> long
    RETURN EXECUTE "INSERT INTO Changes (scanId, changeType, filePath, oldKey, newKey, oldHash, newHash)
                    VALUES ($scan, $type, $path, $oldKey, $newKey, $oldHash, $newHash) RETURNING changeId"
```

## 7. Portal data endpoints (server → web portal)

```
// All read-only. Shapes are in api-contract.md. Every per-client handler:
// RequireValidClientId, then OpenClientDbReadOnly -> 404 if NULL, empty results if EMPTY.
// Lists are paged (?page=1&pageSize=100, pageSize capped at 1000).

// GET /api/v1/portal/summary   -- tiles: totals over the latest scan of each client
FUNCTION GetSummary() -> IResult
    totals = new Counts()
    FOR EACH client IN QUERY indexConn "SELECT clientId, status FROM Clients"
        latest = QUERY clientDb "SELECT * FROM Scans ORDER BY scanStartedAt DESC LIMIT 1"
        IF latest IS NOT NULL THEN totals += CountsFrom(latest)
    RETURN Json({ clients, activeClients, latest: totals,
                  unacknowledgedAlerts: QUERY indexConn "SELECT COUNT(*) FROM Alerts WHERE acknowledgedAt IS NULL" })

// GET /api/v1/portal/scans?clientId=&from=&to=   -- scan imports table, newest first
FUNCTION GetScans(clientId, from, to, page) -> IResult
    clients = clientId IS NULL ? all Clients : [clientId]
    // Each client DB: its newest (page * pageSize) rows in range; merge by scanStartedAt DESC,
    // then take the requested page. totalCount = sum of per-client COUNT(*).
    rows = FOR EACH c IN clients:
        QUERY "SELECT * FROM Scans
               WHERE ($from IS NULL OR scanStartedAt >= $from) AND ($to IS NULL OR scanStartedAt <= $to)
               ORDER BY scanStartedAt DESC LIMIT $page * $size"
    RETURN Json(Page( MergeByStartedDesc(rows) WITH clientId, displayName,
                      durationSeconds = scanFinishedAt - scanStartedAt ))

// GET /api/v1/portal/clients, /clients/{clientId}
FUNCTION GetClient(clientId) -> IResult
    row = QUERY indexConn "SELECT * FROM Clients WHERE clientId = $id" OR RETURN 404
    RETURN Json({ ...row, directories: ParseJson(row.directoriesJson),
                  currentFileCount: QUERY "SELECT COUNT(*) FROM Data WHERE active = 1",
                  totalScans:       QUERY "SELECT COUNT(*) FROM Scans",
                  latestScan:       QUERY "SELECT * FROM Scans ORDER BY scanStartedAt DESC LIMIT 1" })

// GET /api/v1/portal/clients/{clientId}/scans/{scanId}/changes?type=
FUNCTION GetScanChanges(clientId, scanId, type, page) -> IResult
    // Changes made in this scan, plus errors that started earlier and were still going on in it.
    // Scans merge strictly in order and open errors are extended or closed every scan, so
    // "going on during scan S" is exactly scanId <= S <= lastSeenScanId.
    RETURN Json(Page( QUERY "SELECT changeType, filePath, oldHash, newHash, scanId AS firstScanId,
                                    lastSeenScanId, seenCount, (scanId < $scanId) AS ongoing
                             FROM Changes
                             WHERE ($type IS NULL OR changeType = $type)
                               AND (scanId = $scanId
                                    OR (changeType = 'ERROR' AND scanId < $scanId AND lastSeenScanId >= $scanId))
                             ORDER BY filePath LIMIT $size OFFSET $offset" ))

// GET /api/v1/portal/clients/{clientId}/tree?path=   -- one level, lazy-loaded
FUNCTION GetTree(clientId, path) -> IResult
    IF path IS NULL THEN
        RETURN Json({ path: NULL, folders: roots from Clients.directoriesJson (with counts + attention), files: [] })
    prefix  = path + "/"                                   // ordinal prefix; escape % and _ for LIKE
    latest  = QUERY "SELECT scanId FROM Scans ORDER BY scanStartedAt DESC LIMIT 1"
    badges  = QUERY "SELECT filePath, changeType, newHash FROM Changes
                     WHERE scanId = $latest AND changeType <> 'ERROR' AND filePath LIKE $prefix || '%' ESCAPE '\'
                     UNION ALL
                     SELECT o.filePath, 'ERROR', c.newHash FROM OpenErrors o JOIN Changes c ON c.changeId = o.changeId
                     WHERE o.filePath LIKE $prefix || '%' ESCAPE '\'"      -- errors going on now
    active  = QUERY "SELECT filePath, fileSize, hash FROM Data
                     WHERE active = 1 AND filePath LIKE $prefix || '%' ESCAPE '\'"
    // Direct children: a path whose remainder after prefix has no "/" is a file in this folder;
    // otherwise its first segment is a subfolder. Files DELETED in the latest scan are added
    // from badges so they can be shown. A folder's error is its own ERROR badge
    // (DIR_UNREADABLE / DIR_NOT_FOUND); needsAttention = any badge at or under it.
    RETURN Json({ path, folders, files })

// GET /api/v1/portal/clients/{clientId}/file?path=   -- details + full history
FUNCTION GetFile(clientId, path) -> IResult
    // Built from the Changes log, one row per event, so each event appears exactly once.
    // The joined Data row is the one the event is about: the new row for NEW / CHANGED / ERROR,
    // the removed row for DELETED.
    // ERROR events carry their range: last scan seen and how many scans they lasted
    history = QUERY "SELECT s.scanId, s.scanStartedAt, c.changeType,
                            COALESCE(c.newHash, c.oldHash) AS hash, d.fileSize, d.hashDate, d.active,
                            c.seenCount, (SELECT scanStartedAt FROM Scans WHERE scanId = c.lastSeenScanId) AS lastSeenAt
                     FROM Changes c
                     JOIN Scans s     ON s.scanId = c.scanId
                     LEFT JOIN Data d ON d.Key = COALESCE(c.newKey, c.oldKey)
                     WHERE c.filePath = $path
                     ORDER BY s.scanStartedAt, c.changeId"
    IF history IS EMPTY THEN RETURN 404
    current     = QUERY "SELECT fileSize, hash FROM Data WHERE filePath = $path AND active = 1"
    firstSeen   = first NEW event's scanStartedAt
    lastChanged = last NEW or CHANGED event's scanStartedAt
    // Unchanged scans add no rows, so "last checked" is the latest scan unless the file
    // was deleted or its folder was unreadable in it
    lastChecked = latest scan's scanStartedAt IF current IS NOT NULL AND the file isn't under a
                  folder error in that scan, ELSE the last event's scanStartedAt
    status      = its open error's code IF the path is in OpenErrors, ELSE this path's changeType in the
                  latest scan, ELSE "OK"
    RETURN Json({ path, name, fileSize, currentHash, status, firstSeen, lastChanged, lastChecked, history })

// GET /api/v1/portal/clients/{clientId}/files?pathPrefix=&includeInactive=false
FUNCTION GetFiles(clientId, pathPrefix, includeInactive, page) -> IResult
    RETURN Json(Page( QUERY "SELECT filePath, fileSize, hash, hashDate, active FROM Data
                             WHERE ($includeInactive = 1 OR active = 1)
                               AND ($prefix IS NULL OR filePath LIKE $prefix || '%' ESCAPE '\')
                             ORDER BY filePath LIMIT $size OFFSET $offset" ))

// GET /api/v1/portal/trends?measure=&clientId=&from=&to=
FUNCTION GetTrends(measure, clientId, from, to) -> IResult
    column = MAP measure -> Scans column (filesFound, hashedCount, errorCount, newCount,
             changedCount, deletedCount, unmonitoredCount, scanFinishedAt - scanStartedAt); unknown -> 400
    // column comes from this fixed map, never from user text
    RETURN Json({ measure, series: FOR EACH client: points (scanId, scanStartedAt, value) in range })

// GET /api/v1/portal/alerts?includeAcknowledged=false
FUNCTION GetAlerts(includeAcknowledged, page) -> IResult
    RETURN Json(Page( QUERY indexConn
        "SELECT a.*, c.displayName FROM Alerts a JOIN Clients c ON c.clientId = a.clientId
         WHERE ($all = 1 OR a.acknowledgedAt IS NULL) ORDER BY a.lastAt DESC LIMIT $size OFFSET $offset" ))

// POST /api/v1/portal/alerts/{alertId}/acknowledge   (admin)
FUNCTION AcknowledgeAlert(alertId, user) -> IResult
    UPDATE Alerts SET acknowledgedAt = $now, acknowledgedBy = $user WHERE alertId = $id AND acknowledgedAt IS NULL
    IF no row changed THEN RETURN 404
    Audit("ack_alert", user, alertId)
    RETURN 204
```

## 8. Reports

```
// POST /api/v1/portal/reports/export   -- the portal's report tray as one HTML file
FUNCTION ExportReport(ReportExportRequest req, user) -> IResult
    IF req.items.Count == 0 OR req.items.Count > 50 THEN RETURN Problem(400, "invalid_request")
    sections = new List<HtmlSection>()
    FOR EACH item IN req.items
        // Re-query every item from the DBs: never trust data sent by the browser
        SWITCH item.type
            "scanTable":     sections.Add(RenderScanTable(GetScans(item.clientId, item.from, item.to)))
            "clientDetails": sections.Add(RenderClient(GetClient(item.clientId)))
            "folder":        sections.Add(RenderFolder(GetTree(item.clientId, item.path)))
            "file":          sections.Add(RenderFile(GetFile(item.clientId, item.path)))
            "trend":         sections.Add(RenderTrendSvg(GetTrends(item.measure, item.clientId, item.from, item.to)))
    // Times print in UTC, or in the viewer's zone when req.timeZone == "local" (req.utcOffsetMinutes)
    html = RenderReport(req.title, generatedAt: Now(), generatedBy: user.Name, sections, req.timeZone)
           // self-contained: inline CSS, inline SVG charts, every value HTML-encoded
    RETURN File(html, "text/html", "fileguard-report-" + UnixNow() + ".html")
    // Built on demand and returned, never saved

// POST /api/v1/portal/reports/changes.csv
FUNCTION ExportChangesCsv(ChangesCsvRequest req) -> IResult
    IF req.from > req.to THEN RETURN Problem(400, "invalid_request", "from must be before to")
    clientIds = req.clientIds IS EMPTY ? all Clients : req.clientIds
    // Stream rows straight to the response so big ranges don't build up in memory
    // An ERROR row appears once, with its range, if it was going on at any point in [from, to]
    RETURN StreamCsv("clientId,scanId,scanStartedAt,changeType,filePath,oldHash,newHash,seenCount,lastSeenAt",
        FOR EACH id IN clientIds:
            QUERY "SELECT s.scanId, s.scanStartedAt, c.changeType, c.filePath, c.oldHash, c.newHash,
                          c.seenCount, l.scanStartedAt AS lastSeenAt
                   FROM Changes c JOIN Scans s ON s.scanId = c.scanId
                   LEFT JOIN Scans l ON l.scanId = c.lastSeenScanId
                   WHERE s.scanStartedAt <= $to
                     AND COALESCE(l.scanStartedAt, s.scanStartedAt) >= $from
                     AND c.changeType IN (<one parameter per requested type>)
                   ORDER BY s.scanStartedAt, c.filePath")
    // CSV-escape every field; prefix cells starting with = + - @ with ' (spreadsheet formula injection)
```

## 9. Authentication

```
// ---------- Agent: API key ----------
CLASS ApiKeyHandler : AuthenticationHandler
    FUNCTION HandleAuthenticateAsync()
        header = Request.Headers["Authorization"]
        IF header does not start with "Bearer fgk_" THEN RETURN NoResult      // -> 401 unauthorized
        (keyId, secret) = Split(header.Substring(7))                          // fgk_<keyId>_<secret>
        row = QUERY indexConn "SELECT k.clientId, k.salt, k.hash FROM ApiKeys k
                               JOIN Clients c ON c.clientId = k.clientId
                               WHERE k.keyId = $keyId AND k.revokedAt IS NULL AND c.status = 'active'"
        IF row IS NULL OR NOT FixedTimeEquals(SHA256(row.salt || HexDecode(secret)), row.hash) THEN
            RETURN Fail                                                       // -> 401, same message
        RETURN Success(principal with claim "clientId" = row.clientId)

// ---------- Credentials (shared by keys and tokens) ----------
FUNCTION NewCredential(prefix) -> (id, secret, salt, hash, text)
    id     = Hex(RandomBytes(8))                         // 16 hex chars
    secret = RandomBytes(32)
    salt   = RandomBytes(16)
    RETURN (id, secret, salt, SHA256(salt || secret), prefix + "_" + id + "_" + Hex(secret))

// ---------- Portal users ----------
PortalCookieOptions:
    Cookie.Name = "fg_session"; HttpOnly; SecurePolicy = Always; SameSite = Strict
    SlidingExpiration, ExpireTimeSpan = 30 minutes; absolute limit 8 hours (issued-at claim checked)
    API routes answer 401 / 403 instead of redirecting

// POST /api/v1/auth/login
FUNCTION HandleLogin(LoginRequest req, HttpContext ctx) -> IResult
    user = QUERY "SELECT * FROM PortalUsers WHERE username = $u"
    IF user IS NOT NULL AND user.lockedUntil > Now() THEN
        Audit("login_failed", req.username, "locked"); RETURN Problem(423, "account_locked")
    IF user IS NULL OR user.disabled OR NOT VerifyPassword(req.password, user.passwordHash) THEN
        IF user IS NOT NULL THEN
            failed = user.failedLogins + 1
            UPDATE PortalUsers SET failedLogins = $failed,
                   lockedUntil = (failed >= 5 ? Now() + 15 minutes : NULL) WHERE username = $u
        Audit("login_failed", req.username)
        RETURN Problem(401, "login_failed", "Wrong username or password")   // same text either way
    UPDATE PortalUsers SET failedLogins = 0, lockedUntil = NULL, lastLoginAt = $now WHERE username = $u
    Audit("login_ok", user.username)
    AWAIT ctx.SignInAsync("Portal", principal with name + role)
    RETURN Json({ username, role, csrfToken: Antiforgery.GetAndStoreTokens(ctx).RequestToken })

FUNCTION HashPassword(password) -> string
    salt = RandomBytes(16)
    hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, SHA256, 32)
    RETURN "pbkdf2-sha256$600000$" + B64(salt) + "$" + B64(hash)

FUNCTION VerifyPassword(password, stored) -> bool
    parse iterations, salt, hash from stored; recompute; RETURN FixedTimeEquals(...)

FUNCTION EnsureFirstAdmin()
    IF QUERY "SELECT COUNT(*) FROM PortalUsers" > 0 THEN RETURN
    password = Env("FIM_ADMIN_PASSWORD")
    IF password IS NULL OR password.Length < 12 THEN
        FAIL "No portal users exist. Set FIM_ADMIN_PASSWORD (12+ chars) to create the first admin."
    INSERT INTO PortalUsers (username, passwordHash, role, createdAt) VALUES ('admin', HashPassword(password), 'admin', $now)

// GET/POST/PATCH /api/v1/portal/users (admin): validate username ^[A-Za-z0-9._-]{3,32}$,
// password >= 12 chars, role in (admin, viewer); an admin can't disable or demote themselves;
// never delete users. Audit("user_change", ...).
```

## 10. Agent deployment and enrollment

```
// POST /api/v1/portal/agents   (admin) -- "Deploy new agent"
FUNCTION DeployAgent(DeployRequest req, user) -> IResult
    validate: displayName 1..64 chars; scanIntervalMinutes > 0 if given;
              directories <= 1000 non-blank; notes <= 500
    tx = indexConn.BeginTransaction()
    clientId = UniqueClientId(req.displayName)
    INSERT INTO Clients (clientId, displayName, notes, status, createdAt, createdBy, dbFile)
           VALUES ($id, $name, $notes, 'pending', $now, $user, $id + ".db")
    token = IssueEnrollmentToken(tx, clientId, user)
    Audit("deploy_agent", user, clientId)
    tx.Commit()
    RETURN ConfigFile(201, BuildClientConfig(clientId,
                                             req.scanIntervalMinutes OR config.defaultScanIntervalMinutes,
                                             req.directories OR [], token))

FUNCTION UniqueClientId(displayName) -> string
    id = displayName.ToLowerInvariant()
    replace every char outside [a-z0-9._-] with "-"; collapse runs of "-"; trim "-" and "." at both ends
    id = id[..64]; IF id IS EMPTY THEN id = "client"
    candidate = id; n = 2
    WHILE EXISTS Clients WHERE clientId = candidate
        candidate = id[..(64 - len("-" + n))] + "-" + n; n += 1
    RETURN candidate

FUNCTION IssueEnrollmentToken(tx, clientId, user) -> string
    // Only one usable token per client at a time
    UPDATE EnrollmentTokens SET revokedAt = $now WHERE clientId = $id AND usedAt IS NULL AND revokedAt IS NULL
    (id, _, salt, hash, text) = NewCredential("fge")
    INSERT INTO EnrollmentTokens (tokenId, clientId, salt, hash, createdAt, createdBy, expiresAt)
           VALUES ($id, $clientId, $salt, $hash, $now, $user, $now + config.enrollmentTokenHours * 3600)
    RETURN text                                            // shown once, in the config file

FUNCTION BuildClientConfig(clientId, interval, directories, token) -> json
    // Clients are Windows only, so the paths are fixed defaults (editable on the machine)
    RETURN { clientId, scanIntervalMinutes: interval, directories,
             outputDir: "C:\\FIM\\scans", logPath: "C:\\FIM\\client.log",
             api: { baseUrl: config.publicBaseUrl, enrollmentToken: token, credentialPath: "C:\\FIM\\agent.key",
                    serverKeySha256: config.pinServerKey ? ServerKeyPin.Value : omitted } }
    // Response: application/json, Content-Disposition: attachment; filename="client-config.json"

// POST /api/v1/portal/clients/{clientId}/enrollment   (admin)
FUNCTION NewEnrollment(clientId, user) -> IResult
    client = Clients row OR 404;  IF client.status == 'revoked' THEN RETURN Problem(409, "conflict")
    token  = IssueEnrollmentToken(tx, clientId, user)      // the current key keeps working until redeemed
    Audit("new_enrollment", user, clientId)
    RETURN ConfigFile(201, BuildClientConfig(clientId,
                                             client.scanIntervalMinutes OR default,
                                             ParseJson(client.directoriesJson) OR [], token))

// POST /api/v1/agent/enroll   (no auth; rate-limited)
FUNCTION HandleEnroll(EnrollRequest req) -> IResult
    validate hostname <= 255, os <= 255, clientVersion <= 32
    (tokenId, secret) = Split(req.enrollmentToken)          // fge_<tokenId>_<secret>
    tx = indexConn.BeginTransaction()
    t = QUERY "SELECT t.*, c.status FROM EnrollmentTokens t JOIN Clients c ON c.clientId = t.clientId
               WHERE t.tokenId = $tokenId"
    IF t IS NULL OR t.usedAt IS NOT NULL OR t.revokedAt IS NOT NULL OR t.expiresAt < $now
       OR t.status == 'revoked' OR NOT FixedTimeEquals(SHA256(t.salt || secret), t.hash) THEN
        Audit("enroll", NULL, t?.clientId, "rejected"); tx.Commit()
        RETURN Problem(401, "enrollment_invalid", "Enrollment token is not valid")  // same text for every reason
    UPDATE EnrollmentTokens SET usedAt = $now WHERE tokenId = $tokenId
    UPDATE ApiKeys SET revokedAt = $now WHERE clientId = $clientId AND revokedAt IS NULL
    (keyId, _, salt, hash, apiKey) = NewCredential("fgk")
    INSERT INTO ApiKeys (keyId, clientId, salt, hash, createdAt) VALUES (...)
    UPDATE Clients SET status = 'active', enrolledAt = $now, hostname = $h, os = $os, clientVersion = $v
           WHERE clientId = $clientId
    Audit("enroll", NULL, clientId, "ok")
    tx.Commit()
    RETURN Json({ clientId, apiKey })                     // the only time the key exists in plain text

// POST /api/v1/portal/clients/{clientId}/revoke   (admin)
FUNCTION RevokeClient(clientId, user) -> IResult
    in one transaction: ApiKeys and unused EnrollmentTokens get revokedAt = now; Clients.status = 'revoked'
    Audit("revoke", user, clientId)
    RETURN 204                                            // data and history are kept
```

## 11. HTTPS certificate (self-signed, made by the server)

```
// Runs at startup on the server machine, so the private key never leaves it.
FUNCTION EnsureServerCertificate(tls, password) -> X509Certificate2
    IF password IS BLANK THEN FAIL "Set FIM_CERT_PASSWORD to protect the server's private key"
    IF NOT FileExists(tls.pfxPath) THEN
        key  = RSA.Create(2048)
        cert = IssueCertificate(key, tls)
        Save(cert, key, tls.pfxPath, password)                  // .pfx = key + certificate
        log.Info("Created server key and certificate. Key pin: " + KeyPin(cert))
        RETURN cert
    cert = Load(tls.pfxPath, password)
    IF SanNames(cert) != Set(tls.names) OR cert.NotAfter < Now() + 30 days THEN
        // Reissue with the SAME key: the pin in every client config stays valid
        Copy(tls.pfxPath, tls.pfxPath + ".bak")
        cert = IssueCertificate(cert.GetRSAPrivateKey(), tls)
        Save(cert, cert.GetRSAPrivateKey(), tls.pfxPath, password)
        log.Info("Reissued server certificate for " + Join(tls.names) + " with the same key")
    log.Info("Server key pin (serverKeySha256): " + KeyPin(cert))
    RETURN cert

FUNCTION IssueCertificate(key, tls) -> X509Certificate2
    req = new CertificateRequest("CN=" + tls.names[0], key, SHA256, RSASignaturePadding.Pkcs1)
    san = new SubjectAlternativeNameBuilder()
    FOR EACH name IN tls.names
        IF IPAddress.TryParse(name) AS ip THEN san.AddIpAddress(ip) ELSE san.AddDnsName(name)
    req.CertificateExtensions.Add(san.Build())
    req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([ServerAuthentication OID 1.3.6.1.5.5.7.3.1]))
    req.CertificateExtensions.Add(new X509BasicConstraintsExtension(certificateAuthority: false))
    req.CertificateExtensions.Add(new X509KeyUsageExtension(DigitalSignature | KeyEncipherment))
    cert = req.CreateSelfSigned(Now() - 1 day, Now() + tls.validYears years)
    WriteAllBytes(Combine(ParentOf(tls.pfxPath), "server.cer"), cert.Export(X509ContentType.Cert))  // for browsers
    RETURN cert

// What clients pin: SHA-256 of the public key, unchanged by reissues
FUNCTION KeyPin(cert) -> string
    RETURN Hex(SHA256(cert.PublicKey.ExportSubjectPublicKeyInfo())).ToLowerInvariant()
```

---

## Open questions this pseudocode surfaces

None marked in the code right now; see `open-questions.md`.
