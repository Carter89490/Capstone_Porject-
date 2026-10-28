using System.Globalization;

namespace Client;

/// <summary>
/// Keeps only the newest snapshots for this client; the server does long-term storage.
/// See docs/client-spec.md, "Local snapshot retention".
/// </summary>
internal static class SnapshotRetention
{
    public const int SnapshotsToKeep = 2;

    public static string SnapshotPath(string outputDir, string clientId, long scanStart) =>
        Path.Combine(outputDir, $"scan_{clientId}_{scanStart}.db");

    public static void Prune(string outputDir, string clientId, FileLogger log)
    {
        if (!Directory.Exists(outputDir))
        {
            return;
        }

        var prefix = $"scan_{clientId}_";
        var snapshots = new List<(long ScanStart, string Path)>();
        foreach (var path in Directory.EnumerateFiles(outputDir, "scan_*.db"))
        {
            // Only touch files matching this client's pattern, ordered by the <unixStart> in the name
            var name = Path.GetFileNameWithoutExtension(path);
            if (Path.GetExtension(path).Equals(".db", StringComparison.OrdinalIgnoreCase)
                && name.StartsWith(prefix, StringComparison.Ordinal)
                && long.TryParse(name.AsSpan(prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out var scanStart))
            {
                snapshots.Add((scanStart, path));
            }
        }

        foreach (var (_, path) in snapshots.OrderByDescending(s => s.ScanStart).Skip(SnapshotsToKeep))
        {
            try
            {
                File.Delete(path);
                log.Info($"Deleted old snapshot {path}");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                log.Warn($"Could not delete old snapshot {path} : {e.Message}");
            }
        }
    }
}
