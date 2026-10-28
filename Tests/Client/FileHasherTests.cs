using Client;

namespace Tests.Client;

public class FileHasherTests
{
    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    [InlineData(1023, 1)]
    [InlineData(1024, 1)]
    [InlineData(1025, 2)]
    [InlineData(1024 * 1024, 1024)]
    public void ToKiBRoundsUp(long bytes, long expected)
    {
        Assert.Equal(expected, FileHasher.ToKiB(bytes));
    }

    [Fact]
    public async Task HashesAsLowercaseHexWithSize()
    {
        using var temp = new TempDir();
        var file = temp.File("abc.txt", "abc");

        var (hash, size) = await FileHasher.HashFileAsync(file);

        // Well-known SHA-256 of "abc"
        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hash);
        Assert.Equal(3, size);
    }
}
