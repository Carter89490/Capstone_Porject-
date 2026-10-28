namespace Client;

/// <summary>Path normalization from docs/data-model.md, so the same file always produces the same string.</summary>
internal static class PathNormalizer
{
    public static string Normalize(string path)
    {
        // Absolute, with . and .. resolved, and one separator everywhere
        var full = Path.GetFullPath(path).Replace('\\', '/');

        // Trim a trailing separator, except for a bare root like "C:/" or "/"
        var root = (Path.GetPathRoot(full) ?? string.Empty).Replace('\\', '/');
        while (full.Length > root.Length && full.EndsWith('/'))
        {
            full = full[..^1];
        }

        // Windows paths are case-insensitive; Linux/macOS keep their casing
        return OperatingSystem.IsWindows() ? full.ToLowerInvariant() : full;
    }
}
