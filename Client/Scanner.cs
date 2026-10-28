namespace Client;

internal readonly record struct ScanResult(int HashedCount, int ErrorCount);

/// <summary>
/// One full pass over the configured roots into a new snapshot DB. See docs/client-spec.md,
/// "Scan behavior", and docs/client-pseudocode.md section 4.
/// </summary>
internal sealed class Scanner
{
    private readonly ScanDatabase _db;
    private readonly FileLogger _log;
    private readonly CancellationToken _ct;

    // Guards against overlapping roots and duplicate paths
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

    // Files and folders that failed their first try
    private readonly List<(string FilePath, string Normalized)> _retry = [];
    private readonly List<string> _failedDirs = [];

    private int _hashedCount;
    private int _errorCount;

    private Scanner(ScanDatabase db, FileLogger log, CancellationToken ct)
    {
        _db = db;
        _log = log;
        _ct = ct;
    }

    /// <param name="roots">Normalized root folders (see <see cref="ClientConfig"/>).</param>
    public static async Task<ScanResult> ScanAsync(
        IReadOnlyList<string> roots, string dbPath, FileLogger log, CancellationToken ct = default)
    {
        await using var db = await ScanDatabase.CreateAsync(dbPath, ct);
        var scanner = new Scanner(db, log, ct);
        await scanner.RunAsync(roots);
        await db.CommitAsync(ct);
        return new ScanResult(scanner._hashedCount, scanner._errorCount);
    }

    private async Task RunAsync(IReadOnlyList<string> roots)
    {
        foreach (var root in roots)
        {
            if (!Directory.Exists(root))
            {
                await RecordErrorAsync(PathNormalizer.Normalize(root), filePath: null, HashError.DirNotFound);
                continue;
            }

            foreach (var filePath in EnumerateFilesSafely(root, _failedDirs))
            {
                await ScanFileAsync(filePath);
            }
        }

        // Try 2 for folders: walk each failed folder again. Files found now go through
        // ScanFileAsync like any other (already-hashed ones are skipped by _seen).
        var stillFailedDirs = new List<string>();
        foreach (var dir in _failedDirs.Distinct(StringComparer.Ordinal).ToList())
        {
            foreach (var filePath in EnumerateFilesSafely(dir, stillFailedDirs))
            {
                await ScanFileAsync(filePath);
            }
        }

        foreach (var dir in stillFailedDirs.Distinct(StringComparer.Ordinal))
        {
            await RecordErrorAsync(PathNormalizer.Normalize(dir), filePath: null, HashError.DirUnreadable);
        }

        // Try 2 for files, after every directory is done (most locks are short)
        foreach (var (filePath, normalized) in _retry)
        {
            var error = await TryHashAndInsertAsync(filePath, normalized);
            if (error is not null)
            {
                await RecordErrorAsync(normalized, filePath, error);
            }
        }
    }

    // Hash one file, or queue it for the retry pass. One bad file never stops the scan.
    private async Task ScanFileAsync(string filePath)
    {
        var normalized = PathNormalizer.Normalize(filePath);
        if (!_seen.Add(normalized))
        {
            return;
        }

        var error = await TryHashAndInsertAsync(filePath, normalized);
        if (error is not null)
        {
            _log.Warn($"RETRY LATER {normalized} : {error}");
            _retry.Add((filePath, normalized));
        }
    }

    // Returns null on success, or the error code on failure
    private async Task<string?> TryHashAndInsertAsync(string filePath, string normalized)
    {
        string hash;
        long sizeBytes;
        try
        {
            (hash, sizeBytes) = await FileHasher.HashFileAsync(filePath, _ct);
        }
        catch (Exception e) when (HashError.FromException(e) is { } code)
        {
            return code;
        }

        await _db.InsertAsync(FileHasher.ToKiB(sizeBytes), normalized, hash, UnixNow(), _ct);
        _hashedCount++;
        return null;
    }

    // Record a file or folder that still failed after its second try
    private async Task RecordErrorAsync(string normalizedPath, string? filePath, string error)
    {
        _log.Warn($"ERROR {normalizedPath} : {error}");

        // Size if the file system still reports it (a locked file usually does); NULL for folders
        var sizeKiB = HashError.IsFolderError(error) || filePath is null ? null : TryGetSizeKiB(filePath);
        await _db.InsertAsync(sizeKiB, normalizedPath, error, UnixNow(), _ct);
        _errorCount++;
    }

    // Recursive walk that survives unreadable folders. Directory.EnumerateFiles with
    // SearchOption.AllDirectories aborts on the first access-denied folder, so walk by hand.
    // Folders that can't be listed are added to failedDirs for the retry pass.
    private IEnumerable<string> EnumerateFilesSafely(string root, List<string> failedDirs)
    {
        var stack = new Stack<string>();
        stack.Push(root);

        while (stack.TryPop(out var dir))
        {
            _ct.ThrowIfCancellationRequested();

            string[] files;
            try
            {
                files = Directory.GetFiles(dir);
            }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException)
            {
                _log.Warn($"RETRY LATER DIR {dir} : {e.Message}");
                failedDirs.Add(dir);
                continue;
            }

            foreach (var file in files)
            {
                yield return file;
            }

            try
            {
                foreach (var sub in new DirectoryInfo(dir).GetDirectories())
                {
                    // Don't follow symlinks or junctions: avoids loops and scanning outside the roots
                    if (!sub.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    {
                        stack.Push(sub.FullName);
                    }
                }
            }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException)
            {
                // Files in this folder were read, its subfolders weren't: retry the whole folder
                _log.Warn($"RETRY LATER SUBDIRS of {dir} : {e.Message}");
                failedDirs.Add(dir);
            }
        }
    }

    private static long? TryGetSizeKiB(string filePath)
    {
        try
        {
            return FileHasher.ToKiB(new FileInfo(filePath).Length);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static long UnixNow() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}
