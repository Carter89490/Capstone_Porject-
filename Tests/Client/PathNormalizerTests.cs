using Client;

namespace Tests.Client;

public class PathNormalizerTests
{
    [Fact]
    public void UsesForwardSlashesAndNoTrailingSeparator()
    {
        var input = Path.Combine(Path.GetTempPath(), "a", "b") + Path.DirectorySeparatorChar;

        var normalized = PathNormalizer.Normalize(input);

        Assert.DoesNotContain('\\', normalized);
        Assert.False(normalized.EndsWith('/'));
        Assert.EndsWith("/a/b", normalized, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolvesDotSegments()
    {
        var root = Path.GetTempPath();

        Assert.Equal(
            PathNormalizer.Normalize(Path.Combine(root, "a", "c")),
            PathNormalizer.Normalize(Path.Combine(root, "a", "b", "..", ".", "c")));
    }

    [Fact]
    public void KeepsBareRoot()
    {
        var expected = OperatingSystem.IsWindows() ? "c:/" : "/";
        var input = OperatingSystem.IsWindows() ? @"C:\" : "/";

        Assert.Equal(expected, PathNormalizer.Normalize(input));
    }

    [Fact]
    public void LowercasesOnWindowsOnly()
    {
        var input = Path.Combine(Path.GetTempPath(), "MixedCase");

        var normalized = PathNormalizer.Normalize(input);

        Assert.Equal(OperatingSystem.IsWindows(), normalized.EndsWith("/mixedcase", StringComparison.Ordinal));
    }
}
