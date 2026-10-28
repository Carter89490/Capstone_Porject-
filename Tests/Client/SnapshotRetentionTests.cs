using Client;

namespace Tests.Client;

public class SnapshotRetentionTests
{
    [Fact]
    public void KeepsOnlyTheNewestTwoOfThisClient()
    {
        using var temp = new TempDir();
        temp.File("scan_pc_100.db");
        temp.File("scan_pc_300.db");
        temp.File("scan_pc_200.db");
        temp.File("scan_pc_1000.db");
        temp.File("scan_other_50.db");
        temp.File("scan_pc_notanumber.db");
        temp.File("notes.txt");
        using var log = new FileLogger(Path.Combine(temp.Path, "client.log"));

        SnapshotRetention.Prune(temp.Path, "pc", log);

        var remaining = Directory.GetFiles(temp.Path).Select(Path.GetFileName).Order(StringComparer.Ordinal);
        Assert.Equal(
            ["client.log", "notes.txt", "scan_other_50.db", "scan_pc_1000.db", "scan_pc_300.db", "scan_pc_notanumber.db"],
            remaining);
    }

    [Fact]
    public void MissingOutputDirIsIgnored()
    {
        using var temp = new TempDir();
        using var log = new FileLogger(Path.Combine(temp.Path, "client.log"));

        SnapshotRetention.Prune(Path.Combine(temp.Path, "missing"), "pc", log);
    }
}
