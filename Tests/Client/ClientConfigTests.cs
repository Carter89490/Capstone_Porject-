using Client;

namespace Tests.Client;

public class ClientConfigTests
{
    private const string Api = """{ "baseUrl": "https://fim-server.example.edu" }""";

    [Fact]
    public async Task LoadsAndNormalizesDirectories()
    {
        using var temp = new TempDir();
        var dir = Path.Combine(temp.Path, "Data").Replace("\\", "\\\\");
        var path = temp.File("config.json", $$"""
            {
              "clientId": "pc",
              "scanIntervalMinutes": 0.5,
              "directories": [ "{{dir}}", "{{dir}}/", "{{dir}}/sub/.." ],
              "outputDir": "out",
              "logPath": "client.log",
              "api": {{Api}}
            }
            """);

        var config = await ClientConfig.LoadAsync(path);

        Assert.Equal("pc", config.ClientId);
        Assert.Equal(0.5, config.ScanIntervalMinutes);
        Assert.Equal([PathNormalizer.Normalize(Path.Combine(temp.Path, "Data"))], config.Directories);
    }

    [Theory]
    [InlineData("""{ "scanIntervalMinutes": 5, "directories": ["x"], "outputDir": "o", "logPath": "l", "api": {} }""", "clientId")]
    [InlineData("""{ "clientId": "pc", "scanIntervalMinutes": 0, "directories": ["x"], "outputDir": "o", "logPath": "l", "api": {} }""", "scanIntervalMinutes")]
    [InlineData("""{ "clientId": "pc", "directories": ["x"], "outputDir": "o", "logPath": "l", "api": {} }""", "scanIntervalMinutes")]
    [InlineData("""{ "clientId": "pc", "scanIntervalMinutes": 5, "directories": [], "outputDir": "o", "logPath": "l", "api": {} }""", "directory")]
    [InlineData("""{ "clientId": "pc", "scanIntervalMinutes": 5, "directories": ["x"], "logPath": "l", "api": {} }""", "outputDir")]
    [InlineData("""{ "clientId": "pc", "scanIntervalMinutes": 5, "directories": ["x"], "outputDir": "o", "api": {} }""", "logPath")]
    [InlineData("""{ "clientId": "pc", "scanIntervalMinutes": 5, "directories": ["x"], "outputDir": "o", "logPath": "l" }""", "api")]
    [InlineData("""{ "clientId": "a/b", "scanIntervalMinutes": 5, "directories": ["x"], "outputDir": "o", "logPath": "l", "api": {} }""", "clientId")]
    [InlineData("""not json""", "JSON")]
    public async Task RejectsInvalidConfig(string json, string expectedInMessage)
    {
        using var temp = new TempDir();
        var path = temp.File("config.json", json);

        var e = await Assert.ThrowsAsync<ClientConfigException>(() => ClientConfig.LoadAsync(path));

        Assert.Contains(expectedInMessage, e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MissingFileIsAConfigError()
    {
        using var temp = new TempDir();

        await Assert.ThrowsAsync<ClientConfigException>(
            () => ClientConfig.LoadAsync(Path.Combine(temp.Path, "nope.json")));
    }

    [Fact]
    public async Task ExampleConfigIsValid()
    {
        var example = Path.Combine(AppContext.BaseDirectory, "client-config.example.json");

        var config = await ClientConfig.LoadAsync(example);

        Assert.Equal(5, config.ScanIntervalMinutes);
    }
}
