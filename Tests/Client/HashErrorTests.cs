using Client;

namespace Tests.Client;

public class HashErrorTests
{
    public static TheoryData<Exception, string?> Cases => new()
    {
        { new UnauthorizedAccessException(), HashError.PermissionDenied },
        { new FileNotFoundException(), HashError.NotFound },
        { new DirectoryNotFoundException(), HashError.NotFound },
        { new IOException("sharing violation", unchecked((int)0x80070020)), HashError.Locked },
        { new IOException("lock violation", unchecked((int)0x80070021)), HashError.Locked },
        { new IOException("other"), HashError.Unreadable },
        { new PathTooLongException(), HashError.Unreadable },
        { new InvalidOperationException(), null },
        { new OperationCanceledException(), null },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void MapsExceptionsToCodes(Exception e, string? expected)
    {
        Assert.Equal(expected, HashError.FromException(e));
    }

    [Fact]
    public void CodesCanNeverLookLikeAHash()
    {
        string[] codes =
        [
            HashError.Locked, HashError.PermissionDenied, HashError.NotFound,
            HashError.Unreadable, HashError.DirUnreadable, HashError.DirNotFound,
        ];

        Assert.All(codes, c => Assert.NotEqual(64, c.Length));
    }
}
