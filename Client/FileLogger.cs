namespace Client;

/// <summary>Minimal logger: each line goes to the console and is appended to the log file.</summary>
internal sealed class FileLogger : IDisposable
{
    private readonly StreamWriter _writer;
    private readonly Lock _lock = new();

    public FileLogger(string logPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(logPath));
        if (directory is not null)
        {
            Directory.CreateDirectory(directory);
        }

        var stream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read);
        _writer = new StreamWriter(stream) { AutoFlush = true };
    }

    public void Info(string message) => Write("INFO ", message);

    public void Warn(string message) => Write("WARN ", message);

    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {level} {message}";
        lock (_lock)
        {
            Console.WriteLine(line);
            _writer.WriteLine(line);
        }
    }

    public void Dispose() => _writer.Dispose();
}
