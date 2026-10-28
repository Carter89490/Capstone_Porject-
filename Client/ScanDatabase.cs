using Microsoft.Data.Sqlite;

namespace Client;

/// <summary>
/// One scan's snapshot DB (table Data, docs/data-model.md). All rows go in one transaction;
/// disposing without <see cref="CommitAsync"/> rolls everything back.
/// </summary>
internal sealed class ScanDatabase : IAsyncDisposable
{
    private const string CreateTableSql = """
        CREATE TABLE IF NOT EXISTS Data (
            Key      INTEGER PRIMARY KEY,
            fileSize INTEGER,
            filePath TEXT    NOT NULL,
            hash     TEXT    NOT NULL,
            hashDate INTEGER NOT NULL
        );
        """;

    private const string InsertSql =
        "INSERT INTO Data (fileSize, filePath, hash, hashDate) VALUES ($size, $path, $hash, $date)";

    private readonly SqliteConnection _connection;
    private readonly SqliteTransaction _transaction;
    private readonly SqliteCommand _insert;
    private readonly SqliteParameter _size;
    private readonly SqliteParameter _path;
    private readonly SqliteParameter _hash;
    private readonly SqliteParameter _date;

    private ScanDatabase(SqliteConnection connection, SqliteTransaction transaction)
    {
        _connection = connection;
        _transaction = transaction;
        _insert = connection.CreateCommand();
        _insert.Transaction = transaction;
        _insert.CommandText = InsertSql;
        _size = _insert.Parameters.Add("$size", SqliteType.Integer);
        _path = _insert.Parameters.Add("$path", SqliteType.Text);
        _hash = _insert.Parameters.Add("$hash", SqliteType.Text);
        _date = _insert.Parameters.Add("$date", SqliteType.Integer);
    }

    public static async Task<ScanDatabase> CreateAsync(string dbPath, CancellationToken ct = default)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (directory is not null)
        {
            Directory.CreateDirectory(directory);
        }

        // A snapshot is always a fresh file, never appended to
        File.Delete(dbPath);

        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            // No pooling, so the file is released on dispose and can be uploaded or deleted
            Pooling = false,
        }.ToString();

        var connection = new SqliteConnection(connectionString);
        try
        {
            await connection.OpenAsync(ct);

            await using (var create = connection.CreateCommand())
            {
                create.CommandText = CreateTableSql;
                await create.ExecuteNonQueryAsync(ct);
            }

            var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(ct);
            return new ScanDatabase(connection, transaction);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    /// <summary>Inserts one row. <paramref name="sizeKiB"/> is null only on error rows.</summary>
    public async Task InsertAsync(long? sizeKiB, string filePath, string hash, long hashDate, CancellationToken ct = default)
    {
        _size.Value = sizeKiB is { } size ? size : DBNull.Value;
        _path.Value = filePath;
        _hash.Value = hash;
        _date.Value = hashDate;
        await _insert.ExecuteNonQueryAsync(ct);
    }

    public Task CommitAsync(CancellationToken ct = default) => _transaction.CommitAsync(ct);

    public async ValueTask DisposeAsync()
    {
        await _insert.DisposeAsync();
        await _transaction.DisposeAsync();
        await _connection.DisposeAsync();
    }
}
