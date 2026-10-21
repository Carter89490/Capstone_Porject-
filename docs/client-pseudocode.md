# File Integrity Monitor: Client Pseudocode

Follows `CLAUDE.md` and the specs in `docs/`. Target: C# / .NET 10 (LTS), Microsoft.Data.Sqlite, async I/O.
Anything the team hasn't decided is marked `TODO(open-question)`. Anything the API team owns is marked `API_PLACEHOLDER`.

## Design choices made here (not in the brief, easy to change)

- **Fresh snapshot DB per scan.** Each run writes a new local SQLite file with every file it hashed. The server does all diffing (new / changed / deleted), so the client stays simple and never needs to remember earlier scans.
- **No client ID in the DB (decided by Sam, 2026-10-19).** The server keeps one DB per client and the API tells it which client is sending, so rows don't carry a client ID. That column is replaced by `fileSize`: the file's size in KiB, rounded up. The config's `clientId` is only used for local file names and logs.
- **Locked or unreadable files get two tries (decided by Sam, 2026-10-19).** A file that fails during the main walk goes on a retry list. After every directory is hashed, the list is tried once more. A file that still fails is written to the DB with a fixed error code in `hash` instead of a hash, so the server can report the failed attempt. Folders work the same way: a folder that can't be listed is retried once, then recorded with its folder path and `DIR_UNREADABLE` (or `DIR_NOT_FOUND` for a missing root). Real hashes are always 64 hex characters, so a code can never be mistaken for one.

---

## 1. Config

```
// client-config.json (example)
{
  "clientId":    "lab-pc-07",              // local snapshot names and logs; the server gets the ID from the API
  "scanIntervalHours": 6,                   // scan + upload every X hours (decided by Sam, 2026-10-19)
  "directories": [ "C:\\Data\\Important", "D:\\Records" ],
  "outputDir":   "C:\\ProgramData\\FIM\\scans",
  "logPath":     "C:\\ProgramData\\FIM\\client.log",
  "api": {                                  // API_PLACEHOLDER: fields the API team defines
    "baseUrl":        "https://fim-server.example.edu",
    "clientCertPath": "C:\\ProgramData\\FIM\\client.pfx",
    "apiKeyEnvVar":   "FIM_API_KEY"         // secrets come from env/OS store, never hard-coded
  }
}

RECORD ClientConfig
    clientId     : string
    scanIntervalHours : double              // > 0; fractions allowed (0.5 = every 30 min)
    directories  : list<string>
    outputDir    : string
    logPath      : string
    api          : ApiSettings              // API_PLACEHOLDER

FUNCTION LoadConfig(path) -> ClientConfig
    IF NOT FileExists(path) THEN FAIL "Config not found: " + path
    config = JsonDeserialize<ClientConfig>(ReadAllText(path))

    IF IsBlank(config.clientId)          THEN FAIL "clientId is required"
    IF config.directories IS EMPTY       THEN FAIL "at least one directory is required"
    IF config.scanIntervalHours <= 0     THEN FAIL "scanIntervalHours must be greater than 0"

    // Normalize and de-duplicate the roots so overlapping entries aren't scanned twice
    config.directories = Distinct( MAP config.directories USING NormalizePath )
    RETURN config
```

## 2. Entry point and scheduling

```
FUNCTION Main(args)
    configPath = args[0] OR "client-config.json"
    config     = LoadConfig(configPath)
    logger     = OpenLog(config.logPath)

    // Scan + upload every scanIntervalHours (from the config). The first scan runs at startup.
    // Runs until the process is stopped; host it as a Windows Service or systemd service
    // so it starts with the machine.
    interval = TimeSpan.FromHours(config.scanIntervalHours)
    LOOP FOREVER
        started = Now()
        TRY
            AWAIT RunOnce(config, logger)
        CATCH Exception AS e
            // One failed run (disk full, DB error...) must not kill the schedule
            logger.Error("Scan run failed: " + e)
        // Measure from the start of the run so scans don't drift later each cycle.
        // If a scan took longer than the interval, the next one starts right away.
        wait = interval - (Now() - started)
        IF wait > 0 THEN AWAIT Delay(wait)

FUNCTION RunOnce(config, logger)
    scanStart = UnixTimeSecondsNow()
    dbPath    = Combine(config.outputDir, "scan_" + config.clientId + "_" + scanStart + ".db")

    result = AWAIT ScanAllDirectories(config, dbPath, logger)
    logger.Info("Scan done: " + result.hashedCount + " hashed, " + result.errorCount + " recorded as errors")

    uploaded = AWAIT UploadScan(config, dbPath, scanStart, logger)
    IF uploaded THEN
        logger.Info("Upload succeeded")
        // TODO(open-question): keep or delete local snapshots after a successful upload?
    ELSE
        // Don't re-send this snapshot later: the next scheduled scan uploads a newer one, and
        // the server rejects a scan older than one it already merged. Kept only for debugging.
        logger.Warn("Upload failed; snapshot kept at " + dbPath + ". Next scheduled scan will upload fresh data.")
```

## 3. Local SQLite database (shared schema)

```
FUNCTION CreateScanDatabase(dbPath) -> SqliteConnection
    EnsureDirectoryExists(ParentOf(dbPath))
    conn = new SqliteConnection("Data Source=" + dbPath)
    AWAIT conn.OpenAsync()

    EXECUTE conn:
        CREATE TABLE IF NOT EXISTS Data (
            Key      INTEGER PRIMARY KEY,
            fileSize INTEGER,               -- size in KiB, rounded up (0 for an empty file);
                                            -- NULL on error rows where the size couldn't be read
            filePath TEXT    NOT NULL,
            hash     TEXT    NOT NULL,      -- SHA-256, lowercase hex, OR an error code (section 4)
            hashDate INTEGER NOT NULL       -- Unix time (seconds)
        );
    RETURN conn

FUNCTION InsertRow(conn, transaction, fileSizeKiB, filePath, hash, hashDate)
    // Parameterized SQL only. fileSizeKiB may be NULL (error rows).
    cmd = conn.CreateCommand(
        "INSERT INTO Data (fileSize, filePath, hash, hashDate) VALUES ($size, $path, $hash, $date)", transaction)
    cmd.Parameters.Add("$size", fileSizeKiB OR DBNull)
    cmd.Parameters.Add("$path", filePath)
    cmd.Parameters.Add("$hash", hash)
    cmd.Parameters.Add("$date", hashDate)
    AWAIT cmd.ExecuteNonQueryAsync()
```

## 4. Scanning

```
// Fixed error codes stored in the hash column when a file or folder can't be read.
// Shared with the server: keep this list identical on both sides.
ENUM HashError
    // File errors: filePath is the file
    LOCKED            = "LOCKED"             // another process holds an exclusive lock
    PERMISSION_DENIED = "PERMISSION_DENIED"  // no read access
    NOT_FOUND         = "NOT_FOUND"          // file vanished mid-scan
    UNREADABLE        = "UNREADABLE"         // any other I/O failure
    // Folder errors: filePath is the folder. The server keeps the files under it as they were.
    DIR_UNREADABLE    = "DIR_UNREADABLE"     // folder couldn't be listed (permissions, I/O)
    DIR_NOT_FOUND     = "DIR_NOT_FOUND"      // a configured root folder doesn't exist (e.g. drive unplugged)

RECORD ScanResult
    hashedCount : int
    errorCount  : int

FUNCTION ScanAllDirectories(config, dbPath, logger) -> ScanResult
    result     = new ScanResult()
    conn       = AWAIT CreateScanDatabase(dbPath)
    tx         = conn.BeginTransaction()        // one transaction = much faster bulk inserts
    seen       = new HashSet<string>()          // guards against overlapping roots / duplicate paths
    retry      = new List<(string filePath, string normalized)>()   // files that failed the first try
    failedDirs = new List<string>()             // folders that failed the first try

    // Hash one file, or queue it for the retry pass
    LOCAL FUNCTION ScanFile(filePath)
        normalized = NormalizePath(filePath)
        IF NOT seen.Add(normalized) THEN RETURN
        // Try 1. One bad file never stops the scan.
        error = AWAIT TryHashAndInsert(conn, tx, filePath, normalized, result)
        IF error IS NOT NULL THEN
            logger.Warn("RETRY LATER " + normalized + " : " + error)
            retry.Add((filePath, normalized))

    // Record a file or folder that still failed after its second try
    LOCAL FUNCTION RecordError(normalizedPath, error)
        logger.Warn("ERROR " + normalizedPath + " : " + error)
        // Size if the file system still reports it (a locked file usually does); NULL for folders
        size = IsFolderError(error) ? NULL : TryGetSizeKiB(normalizedPath)
        AWAIT InsertRow(conn, tx, size, normalizedPath, error, UnixTimeSecondsNow())
        result.errorCount += 1

    FOR EACH root IN config.directories
        IF NOT DirectoryExists(root) THEN
            AWAIT RecordError(NormalizePath(root), HashError.DIR_NOT_FOUND)
            CONTINUE
        FOR EACH filePath IN EnumerateFilesSafely(root, logger, failedDirs)
            AWAIT ScanFile(filePath)

    // Try 2 for folders: walk each failed folder again. Files found now go through
    // ScanFile like any other (already-hashed ones are skipped by `seen`).
    stillFailedDirs = new List<string>()
    FOR EACH dir IN Distinct(failedDirs)
        FOR EACH filePath IN EnumerateFilesSafely(dir, logger, stillFailedDirs)
            AWAIT ScanFile(filePath)
    FOR EACH dir IN Distinct(stillFailedDirs)
        AWAIT RecordError(NormalizePath(dir), HashError.DIR_UNREADABLE)

    // Try 2 for files: after every directory is done, give failed files one more chance
    // (most locks are short, e.g. a file being saved)
    FOR EACH (filePath, normalized) IN retry
        error = AWAIT TryHashAndInsert(conn, tx, filePath, normalized, result)
        IF error IS NOT NULL THEN
            AWAIT RecordError(normalized, error)    // error code in place of a hash

    tx.Commit()
    conn.Close()
    RETURN result

// Returns NULL on success, or the HashError code on failure
FUNCTION TryHashAndInsert(conn, tx, filePath, normalized, result) -> string OR NULL
    TRY
        (hash, sizeBytes) = AWAIT HashFile(filePath)
        hashDate = UnixTimeSecondsNow()
        AWAIT InsertRow(conn, tx, ToKiB(sizeBytes), normalized, hash, hashDate)
        result.hashedCount += 1
        RETURN NULL
    CATCH UnauthorizedAccessException                      RETURN HashError.PERMISSION_DENIED
    CATCH (FileNotFoundException, DirectoryNotFoundException) RETURN HashError.NOT_FOUND
    CATCH IOException AS e WHEN IsSharingViolation(e)      RETURN HashError.LOCKED
    CATCH IOException                                      RETURN HashError.UNREADABLE

// Size in KiB, rounded up so any non-empty file is at least 1 (1 KiB = 1024 bytes)
FUNCTION ToKiB(bytes) -> long
    RETURN (bytes + 1023) / 1024             // integer division

FUNCTION TryGetSizeKiB(path) -> long OR NULL
    TRY RETURN ToKiB(new FileInfo(path).Length)
    CATCH Exception RETURN NULL

FUNCTION IsFolderError(error) -> bool
    RETURN error IN (HashError.DIR_UNREADABLE, HashError.DIR_NOT_FOUND)

// Windows reports a lock as IOException with HResult 0x80070020 (sharing violation)
// or 0x80070021 (lock violation)
FUNCTION IsSharingViolation(IOException e) -> bool
    code = e.HResult & 0xFFFF
    RETURN code == 32 OR code == 33

// Recursive walk that survives unreadable subdirectories.
// (Directory.EnumerateFiles with SearchOption.AllDirectories aborts on the first
//  access-denied folder, so walk manually.)
// Folders that can't be listed are added to failedDirs for the retry pass.
FUNCTION EnumerateFilesSafely(root, logger, failedDirs) -> sequence<string>
    stack = new Stack<string>([root])
    WHILE stack NOT EMPTY
        dir = stack.Pop()

        TRY files = Directory.EnumerateFiles(dir)
        CATCH (UnauthorizedAccessException, IOException) AS e
            logger.Warn("RETRY LATER DIR " + dir + " : " + e.Message)
            failedDirs.Add(dir)
            CONTINUE

        FOR EACH f IN files
            YIELD f

        TRY
            FOR EACH sub IN Directory.EnumerateDirectories(dir)
                // Don't follow symlinks / junctions: avoids loops and scanning outside the roots
                IF NOT IsReparsePoint(sub) THEN stack.Push(sub)
        CATCH (UnauthorizedAccessException, IOException) AS e
            // Files in this folder were read, its subfolders weren't: retry the whole folder
            logger.Warn("RETRY LATER SUBDIRS of " + dir + " : " + e.Message)
            failedDirs.Add(dir)
```

## 5. Hashing and path normalization

```
FUNCTION HashFile(path) -> (string hash, long sizeBytes)
    // Streamed: never loads the whole file into memory
    stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                            FileShare.ReadWrite,          // tolerate files other apps have open
                            bufferSize: 1 MB, useAsync: true)
    USING stream
        bytes     = AWAIT SHA256.HashDataAsync(stream)
        sizeBytes = stream.Position                     // bytes actually hashed, from the same read
    RETURN (Convert.ToHexString(bytes).ToLowerInvariant(), sizeBytes)

FUNCTION NormalizePath(path) -> string
    full = Path.GetFullPath(path)                          // absolute, resolves . and ..
    full = full.Replace('\\', '/')                         // one separator everywhere
    full = TrimTrailingSeparator(full)                     // except for a bare root like "C:/"
    IF OperatingSystem.IsWindows() THEN
        full = full.ToLowerInvariant()                     // Windows paths are case-insensitive
    // Linux/macOS: keep original casing (case-sensitive file systems)
    RETURN full
```

## 6. Upload (API placeholders)

```
// Everything in this section is a placeholder for the teammates' secure API.
// Keep the contract: HTTPS only + per-client key or certificate.

FUNCTION UploadScan(config, dbPath, scanStart, logger) -> bool
    client = CreateApiClient(config.api)                   // API_PLACEHOLDER

    // Retry only transient failures (network errors, timeouts, 5xx), per the API contract.
    // Any 4xx (400 bad upload, 401/403 auth, 409 already merged, ...) won't change on a resend.
    maxAttempts = 3                                        // TODO(open-question): retry policy
    FOR attempt FROM 1 TO maxAttempts
        TRY
            response = AWAIT ApiUploadScan(client, scanStart, dbPath)
            IF response.Success THEN RETURN true
            logger.Warn("Upload rejected (" + response.StatusCode + "): " + response.Message)
            IF response.StatusCode < 500 THEN RETURN false        // 4xx: don't retry
        CATCH (HttpRequestException, TaskCanceledException) AS e
            logger.Warn("Upload attempt " + attempt + " failed: " + e.Message)
        IF attempt < maxAttempts THEN
            AWAIT Delay(Backoff(attempt))                  // e.g. 5s, 30s; no wait after the last try
    RETURN false

FUNCTION CreateApiClient(apiSettings) -> HttpClient
    // API_PLACEHOLDER: the API team decides key vs. certificate and how it's attached.
    handler = new HttpClientHandler()
    IF apiSettings.clientCertPath IS SET THEN
        handler.ClientCertificates.Add(LoadCertificate(apiSettings.clientCertPath))
    http = new HttpClient(handler) { BaseAddress = apiSettings.baseUrl }
    IF NOT http.BaseAddress.Scheme == "https" THEN FAIL "API must use HTTPS"
    IF apiSettings.apiKeyEnvVar IS SET THEN
        http.DefaultRequestHeaders["Authorization"] =
            "Bearer " + GetEnvironmentVariable(apiSettings.apiKeyEnvVar)   // API_PLACEHOLDER header name
    RETURN http

FUNCTION ApiUploadScan(http, scanStart, dbPath) -> ApiResponse
    // API_PLACEHOLDER: endpoint path, payload format, and response shape are the API team's call.
    // Shown here as a multipart upload of the whole snapshot DB file.
    content = new MultipartFormDataContent()
    // No clientId field: the server takes the client's identity from its API credentials
    content.Add(StringContent(scanStart), "scanStartedAt")
    content.Add(StreamContent(OpenRead(dbPath)), "scanDb", FileName(dbPath))

    httpResponse = AWAIT http.PostAsync("/api/v1/scans", content)   // API_PLACEHOLDER route
    RETURN ApiResponse.From(httpResponse)                            // API_PLACEHOLDER
```

---

## Open questions this pseudocode surfaces

- **Retry and local retention.** How many upload retries, and whether to delete local snapshots after a successful upload.
- **Upload format.** Whole SQLite file vs. JSON rows is the API team's call; the pseudocode assumes the whole file.
