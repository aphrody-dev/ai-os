// SovereignEnv.cs — Zero-dependency .NET 10/11 C# loader & secret redaction helper for C:\aphrody\.env
#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace Aphrody.EnvKit;

public sealed class SovereignEnv
{
    public static string DefaultMonorepoEnvPath =>
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\aphrody\.env" : "/src/.env";

    private static readonly Regex SecretKeyRegex = new(
        @"(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|NUGET_API_KEY)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex SecretPrefixRegex = new(
        @"^(sk-|AIza|figd_|gh[pousr]_|github_pat_|npm_|pypi-|ctx7sk-|vcp_|napi_)",
        RegexOptions.Compiled);

    private readonly Dictionary<string, string> _values;

    public string EnvPath { get; }

    private SovereignEnv(string envPath, Dictionary<string, string> values)
    {
        EnvPath = envPath;
        _values = values;
    }

    public string? Get(string key) =>
        _values.TryGetValue(key, out var val) && val.Length > 0 ? val : Environment.GetEnvironmentVariable(key);

    public IReadOnlyDictionary<string, string> Redacted()
    {
        var result = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in _values)
        {
            result[k] = MaskValue(k, v);
        }
        return result;
    }

    public override string ToString()
    {
        var sb = new StringBuilder();
        sb.Append("SovereignEnv(").Append(EnvPath).Append(") { ");
        var first = true;
        foreach (var (k, v) in Redacted())
        {
            if (!first) sb.Append(", ");
            sb.Append(k).Append('=').Append(v);
            first = false;
        }
        sb.Append(" }");
        return sb.ToString();
    }

    public static bool IsSecretKey(string key, string value = "")
    {
        var hasPrefix = SecretPrefixRegex.IsMatch(value);
        if ((key.EndsWith("_DIR", StringComparison.OrdinalIgnoreCase) ||
             key.EndsWith("_PATH", StringComparison.OrdinalIgnoreCase) ||
             key.EndsWith("_HOME", StringComparison.OrdinalIgnoreCase)) && !hasPrefix)
        {
            return false;
        }
        if (key.EndsWith("_URL", StringComparison.OrdinalIgnoreCase) &&
            !key.Contains("DATABASE_URL", StringComparison.OrdinalIgnoreCase) && !hasPrefix)
        {
            return false;
        }
        return hasPrefix || SecretKeyRegex.IsMatch(key);
    }

    public static string MaskValue(string key, string? value)
    {
        if (string.IsNullOrEmpty(value)) return "UNSET";
        return IsSecretKey(key, value) ? $"SET [len={value.Length}]" : value;
    }

    public static string ResolveMonorepoEnvPath(string? startDir = null)
    {
        var dir = new DirectoryInfo(startDir ?? Directory.GetCurrentDirectory());
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, ".env");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return DefaultMonorepoEnvPath;
    }

    public static Dictionary<string, string> ParseDotEnv(string content)
    {
        var dict = new Dictionary<string, string>(StringComparer.Ordinal);
        using var reader = new StringReader(content);
        string? rawLine;
        while ((rawLine = reader.ReadLine()) is not null)
        {
            var trimmed = rawLine.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
            if (trimmed.StartsWith("export ", StringComparison.Ordinal))
            {
                trimmed = trimmed[7..].Trim();
            }

            var eq = trimmed.IndexOf('=');
            if (eq <= 0) continue;

            var key = trimmed[..eq].Trim();
            var rawVal = trimmed[(eq + 1)..].Trim();
            string parsed;

            if (rawVal.StartsWith('"'))
            {
                var sb = new StringBuilder();
                var escaped = false;
                for (var i = 1; i < rawVal.Length; i++)
                {
                    var ch = rawVal[i];
                    if (escaped)
                    {
                        sb.Append(ch switch { 'n' => '\n', 'r' => '\r', 't' => '\t', _ => ch });
                        escaped = false;
                    }
                    else if (ch == '\\') escaped = true;
                    else if (ch == '"') break;
                    else sb.Append(ch);
                }
                parsed = sb.ToString();
            }
            else if (rawVal.StartsWith('\''))
            {
                var close = rawVal.IndexOf('\'', 1);
                parsed = close >= 1 ? rawVal[1..close] : rawVal[1..];
            }
            else
            {
                var commentIdx = -1;
                for (var i = 1; i < rawVal.Length; i++)
                {
                    if (rawVal[i] == '#' && char.IsWhiteSpace(rawVal[i - 1]))
                    {
                        commentIdx = i;
                        break;
                    }
                }
                parsed = (commentIdx >= 0 ? rawVal[..commentIdx] : rawVal).Trim();
            }

            dict[key] = parsed;
        }
        return dict;
    }

    public static SovereignEnv Load(
        string? envPath = null,
        string? startDir = null,
        string service = "default",
        IEnumerable<string>? required = null,
        bool overrideExisting = false,
        bool injectProcessEnv = true)
    {
        var target = envPath ?? ResolveMonorepoEnvPath(startDir);
        var parsed = File.Exists(target)
            ? ParseDotEnv(File.ReadAllText(target, Encoding.UTF8))
            : new Dictionary<string, string>(StringComparer.Ordinal);

        var effective = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in parsed)
        {
            var existing = Environment.GetEnvironmentVariable(k);
            if (!overrideExisting && !string.IsNullOrEmpty(existing))
            {
                effective[k] = existing;
            }
            else
            {
                effective[k] = v;
                if (injectProcessEnv && (v.Length > 0 || overrideExisting))
                {
                    Environment.SetEnvironmentVariable(k, v);
                }
            }
        }

        if (required is not null)
        {
            var missing = new List<string>();
            foreach (var req in required)
            {
                var cur = Environment.GetEnvironmentVariable(req);
                if (string.IsNullOrEmpty(cur) && (!effective.TryGetValue(req, out var fv) || string.IsNullOrEmpty(fv)))
                {
                    missing.Add(req);
                }
            }
            if (missing.Count > 0)
            {
                throw new InvalidOperationException(
                    $"[service={service}] Missing required environment variables ({string.Join(", ", missing)}) after checking {target}");
            }
        }

        return new SovereignEnv(target, effective);
    }
}
