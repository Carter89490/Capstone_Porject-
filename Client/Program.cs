using Client;

var configPath = args.Length > 0 ? args[0] : "client-config.json";

ClientConfig config;
try
{
    config = await ClientConfig.LoadAsync(configPath);
}
catch (Exception e) when (e is ClientConfigException or IOException or UnauthorizedAccessException)
{
    Console.Error.WriteLine($"Config error: {e.Message}");
    return 1;
}

using var log = new FileLogger(config.LogPath);

// Ctrl+C stops the schedule cleanly
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

await ScanScheduler.RunAsync(config, log, cts.Token);
return 0;
