# Data Model

Shared by client, API, and server. Don't rename, retype, or change the units of any column without the whole team agreeing.

## Table `Data` (client and server)

| Column | Type | Client | Server | Notes |
|---|---|---|---|---|
| `Key` | INTEGER | ✓ | ✓ | Primary key. The server assigns its own and ignores the client's. |
| `fileSize` | INTEGER | ✓ | ✓ | File size in **KiB, rounded up**: `(bytes + 1023) / 1024`. `0` for an empty file. NULL only on error rows where the size couldn't be read (always NULL for folder errors). Informational only; changes are detected by `hash`. |
| `filePath` | TEXT | ✓ | ✓ | Normalized absolute path (see below). For folder errors, the folder's path. |
| `hash` | TEXT | ✓ | ✓ | SHA-256 as **64 lowercase hex chars**, or one of the error codes below. |
| `hashDate` | INTEGER | ✓ | ✓ | **Unix time in seconds** when the hash (or failed attempt) was taken. |
| `active` | INTEGER | | ✓ | Server only. `1` = current hash for this path, `0` = superseded, deleted, or an error row. |

There is **no `clientId` column**. The server keeps one DB per client and learns the client's identity from the API.

### Client DDL

```sql
CREATE TABLE IF NOT EXISTS Data (
    Key      INTEGER PRIMARY KEY,
    fileSize INTEGER,
    filePath TEXT    NOT NULL,
    hash     TEXT    NOT NULL,
    hashDate INTEGER NOT NULL
);
```

### Server DDL (per-client DB)

```sql
CREATE TABLE IF NOT EXISTS Data (
    Key      INTEGER PRIMARY KEY,
    fileSize INTEGER,
    filePath TEXT    NOT NULL,
    hash     TEXT    NOT NULL,
    hashDate INTEGER NOT NULL,
    active   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS IX_Data_ActivePath ON Data(filePath) WHERE active = 1;
CREATE INDEX IF NOT EXISTS IX_Data_Path ON Data(filePath);
```

The server also has `Scans` and `Changes` tables per client and an `index.db` of known clients. Those are server design choices, not part of the shared contract; see `server-spec.md`.

## Error codes (shared list, identical on client and server)

Stored in `hash` when a file or folder still can't be read after its retry.

| Code | Applies to | Meaning |
|---|---|---|
| `LOCKED` | file | Another process holds a lock (Windows sharing or lock violation) |
| `PERMISSION_DENIED` | file | No read access |
| `NOT_FOUND` | file | File vanished mid-scan |
| `UNREADABLE` | file | Any other I/O failure |
| `DIR_UNREADABLE` | folder | Folder couldn't be listed (permissions, I/O) |
| `DIR_NOT_FOUND` | folder | A configured root folder doesn't exist (e.g. drive unplugged) |

- A real hash is always 64 hex chars, so a code can never be mistaken for one.
- Code that compares hashes must ignore error codes.
- The server rejects any `hash` that is neither `^[0-9a-f]{64}$` nor a known code.

## Path normalization

Applied by the client before storing a path, so the same file always produces the same string:

1. `Path.GetFullPath` (absolute, resolves `.` and `..`)
2. Replace `\` with `/`
3. Trim a trailing separator, except for a bare root like `C:/`
4. On Windows, lowercase (`ToLowerInvariant`). On Linux/macOS keep the original casing.

Because both sides rely on this form, the server can test "is this path under that folder" with a plain ordinal prefix check on `folder + "/"`.
