namespace Client;

/// <summary>
/// Error codes stored in the hash column when a file or folder still can't be read after its retry.
/// Shared with the server (docs/data-model.md): keep this list identical on both sides.
/// </summary>
internal static class HashError
{
    // File errors: filePath is the file
    public const string Locked = "LOCKED";
    public const string PermissionDenied = "PERMISSION_DENIED";
    public const string NotFound = "NOT_FOUND";
    public const string Unreadable = "UNREADABLE";

    // Folder errors: filePath is the folder, fileSize is NULL
    public const string DirUnreadable = "DIR_UNREADABLE";
    public const string DirNotFound = "DIR_NOT_FOUND";

    public static bool IsFolderError(string code) => code is DirUnreadable or DirNotFound;

    /// <summary>Maps a file read failure to its error code, or null if it isn't a file read failure.</summary>
    public static string? FromException(Exception e) => e switch
    {
        UnauthorizedAccessException => PermissionDenied,
        FileNotFoundException or DirectoryNotFoundException => NotFound,
        IOException io when IsSharingViolation(io) => Locked,
        IOException => Unreadable,
        _ => null,
    };

    // Windows reports a lock as HResult 0x80070020 (sharing violation) or 0x80070021 (lock violation)
    private static bool IsSharingViolation(IOException e)
    {
        var code = e.HResult & 0xFFFF;
        return code is 32 or 33;
    }
}
