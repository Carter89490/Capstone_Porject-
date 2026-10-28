using System.Diagnostics;

namespace Client;

/// <summary>
/// Scans once at startup, then every scanIntervalMinutes measured from the start of each scan.
/// See docs/client-spec.md, "Schedule".
/// </summary>
internal static class ScanScheduler
{
    public static async Task RunAsync(ClientConfig config, FileLogger log, CancellationToken ct)
    {
        var interval = TimeSpan.FromMinutes(config.ScanIntervalMinutes);
        log.Info($"Client '{config.ClientId}' started. Scanning {string.Join(", ", config.Directories)} every {interval}.");

        while (!ct.IsCancellationRequested)
        {
            var started = Stopwatch.GetTimestamp();
            try
            {
                await RunOnceAsync(config, log, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                // One failed run (disk full, DB error...) must not kill the schedule
                log.Error($"Scan run failed: {e}");
            }

            // If a scan took longer than the interval, the next one starts right away
            var wait = interval - Stopwatch.GetElapsedTime(started);
            if (wait > TimeSpan.Zero)
            {
                try
                {
                    await Task.Delay(wait, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        log.Info("Client stopped.");
    }

    private static async Task RunOnceAsync(ClientConfig config, FileLogger log, CancellationToken ct)
    {
        var scanStart = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var dbPath = SnapshotRetention.SnapshotPath(config.OutputDir, config.ClientId, scanStart);
        log.Info($"Scan started: {dbPath}");

        ScanResult result;
        try
        {
            result = await Scanner.ScanAsync(config.Directories, dbPath, log, ct);
        }
        catch
        {
            // An incomplete snapshot must never be uploaded
            TryDeleteFile(dbPath, log);
            throw;
        }

        log.Info($"Scan done: {result.HashedCount} hashed, {result.ErrorCount} recorded as errors.");

        // API_PLACEHOLDER: upload the snapshot here (POST /api/v1/scans, see docs/api-contract.md).
        // Not built yet; the API team owns the transport and auth.

        SnapshotRetention.Prune(config.OutputDir, config.ClientId, log);
    }

    private static void TryDeleteFile(string path, FileLogger log)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log.Warn($"Could not delete incomplete snapshot {path} : {e.Message}");
        }
    }
}
