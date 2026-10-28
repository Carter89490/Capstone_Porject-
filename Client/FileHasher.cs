using System.Security.Cryptography;

namespace Client;

internal static class FileHasher
{
    private const int BufferSize = 1024 * 1024;

    /// <summary>Streams the file through SHA-256; never loads the whole file into memory.</summary>
    public static async Task<(string Hash, long SizeBytes)> HashFileAsync(string path, CancellationToken ct = default)
    {
        // FileShare.ReadWrite tolerates files other apps have open
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            BufferSize,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        var bytes = await SHA256.HashDataAsync(stream, ct);

        // Size is the bytes actually hashed, from the same read
        return (Convert.ToHexStringLower(bytes), stream.Position);
    }

    /// <summary>Size in KiB, rounded up so any non-empty file is at least 1.</summary>
    public static long ToKiB(long bytes) => (bytes + 1023) / 1024;
}
