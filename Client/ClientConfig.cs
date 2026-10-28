using System.Text.Json;

namespace Client;

/// <summary>Validated client configuration. See docs/client-spec.md, "Config file".</summary>
internal sealed record ClientConfig(
    string ClientId,
    double ScanIntervalMinutes,
    IReadOnlyList<string> Directories,
    string OutputDir,
    string LogPath,
    ApiSettings Api)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static async Task<ClientConfig> LoadAsync(string path, CancellationToken ct = default)
    {
        if (!File.Exists(path))
        {
            throw new ClientConfigException($"Config not found: {Path.GetFullPath(path)}");
        }

        RawConfig? raw;
        await using (var stream = File.OpenRead(path))
        {
            try
            {
                raw = await JsonSerializer.DeserializeAsync<RawConfig>(stream, JsonOptions, ct);
            }
            catch (JsonException e)
            {
                throw new ClientConfigException($"Config is not valid JSON: {e.Message}");
            }
        }

        if (raw is null)
        {
            throw new ClientConfigException("Config is empty");
        }

        if (string.IsNullOrWhiteSpace(raw.ClientId))
        {
            throw new ClientConfigException("clientId is required");
        }

        // clientId becomes part of the snapshot file names
        if (raw.ClientId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw new ClientConfigException("clientId contains characters that aren't allowed in a file name");
        }

        if (raw.ScanIntervalMinutes is not > 0)
        {
            throw new ClientConfigException("scanIntervalMinutes must be greater than 0");
        }

        if (raw.Directories is null || raw.Directories.Count == 0)
        {
            throw new ClientConfigException("at least one directory is required");
        }

        if (raw.Directories.Any(string.IsNullOrWhiteSpace))
        {
            throw new ClientConfigException("directories can't contain blank entries");
        }

        if (string.IsNullOrWhiteSpace(raw.OutputDir))
        {
            throw new ClientConfigException("outputDir is required");
        }

        if (string.IsNullOrWhiteSpace(raw.LogPath))
        {
            throw new ClientConfigException("logPath is required");
        }

        // API_PLACEHOLDER: the API team defines these fields, so only the section's presence is checked
        if (raw.Api is null)
        {
            throw new ClientConfigException("api is required");
        }

        // Normalize and de-duplicate the roots so overlapping entries aren't scanned twice
        var directories = raw.Directories
            .Select(d => PathNormalizer.Normalize(d!))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        return new ClientConfig(
            raw.ClientId,
            raw.ScanIntervalMinutes.Value,
            directories,
            raw.OutputDir,
            raw.LogPath,
            raw.Api);
    }

    private sealed record RawConfig(
        string? ClientId,
        double? ScanIntervalMinutes,
        List<string?>? Directories,
        string? OutputDir,
        string? LogPath,
        ApiSettings? Api);
}

/// <summary>API_PLACEHOLDER: fields the API team defines. Secrets come from env vars, never the file.</summary>
internal sealed record ApiSettings(string? BaseUrl, string? ClientCertPath, string? ApiKeyEnvVar);

internal sealed class ClientConfigException(string message) : Exception(message);
