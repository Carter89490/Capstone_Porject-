using Client;

using Microsoft.Data.Sqlite;

namespace Tests.Client;

public class ScannerTests
{
    private sealed record Row(long? FileSize, string FilePath, string Hash, long HashDate);

    [Fact]
    public async Task HashesEveryFileRecursively()
    {
        using var temp = new TempDir();
        var root = temp.File("root/a.txt", "abc");
        temp.File("root/sub/b.txt", new string('x', 2000));
        temp.File("root/sub/deeper/empty.txt");
        var rootDir = PathNormalizer.Normalize(Path.GetDirectoryName(root)!);

        var (result, rows) = await ScanAsync(temp, [rootDir]);

        Assert.Equal(new ScanResult(3, 0), result);
        Assert.All(rows, r => Assert.Matches("^[0-9a-f]{64}$", r.Hash));
        Assert.All(rows, r => Assert.StartsWith(rootDir + "/", r.FilePath, StringComparison.Ordinal));

        var abc = Assert.Single(rows, r => r.FilePath.EndsWith("/a.txt", StringComparison.Ordinal));
        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", abc.Hash);
        Assert.Equal(1, abc.FileSize);
        Assert.Equal(2, rows.Single(r => r.FilePath.EndsWith("/b.txt", StringComparison.Ordinal)).FileSize);
        Assert.Equal(0, rows.Single(r => r.FilePath.EndsWith("/empty.txt", StringComparison.Ordinal)).FileSize);
    }

    [Fact]
    public async Task OverlappingRootsAreHashedOnce()
    {
        using var temp = new TempDir();
        temp.File("root/sub/b.txt", "b");
        var rootDir = PathNormalizer.Normalize(Path.Combine(temp.Path, "root"));
        var subDir = PathNormalizer.Normalize(Path.Combine(temp.Path, "root", "sub"));

        var (result, rows) = await ScanAsync(temp, [rootDir, subDir]);

        Assert.Equal(1, result.HashedCount);
        Assert.Single(rows);
    }

    [Fact]
    public async Task MissingRootIsRecordedAndScanContinues()
    {
        using var temp = new TempDir();
        temp.File("root/a.txt", "abc");
        var missing = PathNormalizer.Normalize(Path.Combine(temp.Path, "missing"));
        var rootDir = PathNormalizer.Normalize(Path.Combine(temp.Path, "root"));

        var (result, rows) = await ScanAsync(temp, [missing, rootDir]);

        Assert.Equal(new ScanResult(1, 1), result);
        var error = Assert.Single(rows, r => r.Hash == HashError.DirNotFound);
        Assert.Equal(missing, error.FilePath);
        Assert.Null(error.FileSize);
    }

    [Fact]
    public async Task LockedFileIsRecordedWithItsSize()
    {
        // Exclusive locks that block FileShare.ReadWrite readers are a Windows behavior
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var temp = new TempDir();
        var file = temp.File("root/locked.txt", new string('x', 3000));
        var rootDir = PathNormalizer.Normalize(Path.Combine(temp.Path, "root"));

        ScanResult result;
        List<Row> rows;
        await using (new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            (result, rows) = await ScanAsync(temp, [rootDir]);
        }

        Assert.Equal(new ScanResult(0, 1), result);
        var row = Assert.Single(rows);
        Assert.Equal(HashError.Locked, row.Hash);
        Assert.Equal(3, row.FileSize);
    }

    private static async Task<(ScanResult Result, List<Row> Rows)> ScanAsync(TempDir temp, IReadOnlyList<string> roots)
    {
        var dbPath = Path.Combine(temp.Path, "out", "scan_test_1.db");
        using var log = new FileLogger(Path.Combine(temp.Path, "out", "client.log"));

        var result = await Scanner.ScanAsync(roots, dbPath, log);
        return (result, await ReadRowsAsync(dbPath));
    }

    private static async Task<List<Row>> ReadRowsAsync(string dbPath)
    {
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        }.ToString();

        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT fileSize, filePath, hash, hashDate FROM Data";

        var rows = new List<Row>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            rows.Add(new Row(
                reader.IsDBNull(0) ? null : reader.GetInt64(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetInt64(3)));
        }

        return rows;
    }
}
