// Package envkit provides zero-dependency loading and secret redaction for C:\aphrody\.env.
package envkit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// DefaultMonorepoEnvPath returns the canonical root .env path.
func DefaultMonorepoEnvPath() string {
	if runtime.GOOS == "windows" {
		return `C:\aphrody\.env`
	}
	return "/src/.env"
}

// Options configures LoadWithOptions.
type Options struct {
	EnvPath           string
	StartDir          string
	Service           string
	Required          []string
	Override          bool
	InjectProcessEnv  bool
	DisableAutoInject bool
}

// Env holds loaded key-value pairs while redacting secrets in String() and MarshalJSON().
type Env struct {
	envPath string
	values  map[string]string
}

// EnvPath returns the resolved .env file path.
func (e *Env) EnvPath() string {
	return e.envPath
}

// Get returns the raw value for a key (checking e.values then os.Getenv).
func (e *Env) Get(key string) string {
	if v, ok := e.values[key]; ok && v != "" {
		return v
	}
	return os.Getenv(key)
}

// Redacted returns a map where secret values are replaced by "SET [len=N]".
func (e *Env) Redacted() map[string]string {
	out := make(map[string]string, len(e.values))
	for k, v := range e.values {
		out[k] = MaskValue(k, v)
	}
	return out
}

// String implements fmt.Stringer safely without leaking secret values.
func (e *Env) String() string {
	b, _ := json.Marshal(e.Redacted())
	return string(b)
}

// GoString implements fmt.GoStringer safely without leaking secret values.
func (e *Env) GoString() string {
	return fmt.Sprintf("envkit.Env{path:%q, redacted:%s}", e.envPath, e.String())
}

// MarshalJSON redacts secrets automatically during json.Marshal.
func (e *Env) MarshalJSON() ([]byte, error) {
	return json.Marshal(e.Redacted())
}

// IsSecretKey reports whether key or value prefix represents a credential.
func IsSecretKey(key, value string) bool {
	upper := strings.ToUpper(key)
	prefixes := []string{"sk-", "AIza", "figd_", "ghp_", "gho_", "github_pat_", "npm_", "pypi-", "ctx7sk-"}
	hasPrefix := false
	for _, p := range prefixes {
		if strings.HasPrefix(value, p) {
			hasPrefix = true
			break
		}
	}
	if (strings.HasSuffix(upper, "_DIR") || strings.HasSuffix(upper, "_PATH") || strings.HasSuffix(upper, "_HOME")) && !hasPrefix {
		return false
	}
	if strings.HasSuffix(upper, "_URL") && !strings.Contains(upper, "DATABASE_URL") && !hasPrefix {
		return false
	}
	if hasPrefix {
		return true
	}
	markers := []string{"TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "AUTH", "CREDENTIAL", "DATABASE_URL"}
	for _, m := range markers {
		if strings.Contains(upper, m) {
			return true
		}
	}
	return false
}

// MaskValue returns "UNSET", "SET [len=N]", or the non-secret string.
func MaskValue(key, value string) string {
	if value == "" {
		return "UNSET"
	}
	if IsSecretKey(key, value) {
		return fmt.Sprintf("SET [len=%d]", len(value))
	}
	return value
}

// ResolveMonorepoEnvPath walks upward from startDir looking for .env, falling back to C:\aphrody\.env.
func ResolveMonorepoEnvPath(startDir string) string {
	dir := startDir
	if dir == "" {
		if wd, err := os.Getwd(); err == nil {
			dir = wd
		}
	}
	if dir != "" {
		if abs, err := filepath.Abs(dir); err == nil {
			cur := abs
			for {
				candidate := filepath.Join(cur, ".env")
				if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
					return candidate
				}
				parent := filepath.Dir(cur)
				if parent == cur {
					break
				}
				cur = parent
			}
		}
	}
	return DefaultMonorepoEnvPath()
}

// ParseDotEnv parses standard .env content into a string map.
func ParseDotEnv(content string) map[string]string {
	result := make(map[string]string)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")

	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "export ") {
			trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "export "))
		}
		eqIdx := strings.IndexByte(trimmed, '=')
		if eqIdx <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:eqIdx])
		if !isValidIdent(key) {
			continue
		}
		rawVal := strings.TrimSpace(trimmed[eqIdx+1:])

		var val string
		if strings.HasPrefix(rawVal, `"`) {
			var sb strings.Builder
			escaped := false
			for i := 1; i < len(rawVal); i++ {
				ch := rawVal[i]
				if escaped {
					switch ch {
					case 'n':
						sb.WriteByte('\n')
					case 'r':
						sb.WriteByte('\r')
					case 't':
						sb.WriteByte('\t')
					default:
						sb.WriteByte(ch)
					}
					escaped = false
				} else if ch == '\\' {
					escaped = true
				} else if ch == '"' {
					break
				} else {
					sb.WriteByte(ch)
				}
			}
			val = sb.String()
		} else if strings.HasPrefix(rawVal, `'`) {
			rest := rawVal[1:]
			if closeIdx := strings.IndexByte(rest, '\''); closeIdx >= 0 {
				val = rest[:closeIdx]
			} else {
				val = rest
			}
		} else {
			for i := 1; i < len(rawVal); i++ {
				if rawVal[i] == '#' && (rawVal[i-1] == ' ' || rawVal[i-1] == '\t') {
					rawVal = rawVal[:i]
					break
				}
			}
			val = strings.TrimSpace(rawVal)
		}
		result[key] = val
	}
	return result
}

func isValidIdent(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlpha := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
		isDigit := c >= '0' && c <= '9'
		if i == 0 && !isAlpha {
			return false
		}
		if !isAlpha && !isDigit {
			return false
		}
	}
	return true
}

// Load discovers C:\aphrody\.env (or nearest .env) and injects missing keys into os.Environ.
func Load() (*Env, error) {
	return LoadWithOptions(Options{InjectProcessEnv: true})
}

// LoadWithOptions loads .env with service validation and override control.
func LoadWithOptions(opts Options) (*Env, error) {
	target := opts.EnvPath
	if target == "" {
		target = ResolveMonorepoEnvPath(opts.StartDir)
	}
	inject := opts.InjectProcessEnv && !opts.DisableAutoInject

	parsed := make(map[string]string)
	if data, err := os.ReadFile(target); err == nil {
		parsed = ParseDotEnv(string(data))
	}

	effective := make(map[string]string, len(parsed))
	keys := make([]string, 0, len(parsed))
	for k := range parsed {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, k := range keys {
		v := parsed[k]
		existing := os.Getenv(k)
		if !opts.Override && existing != "" {
			effective[k] = existing
		} else {
			effective[k] = v
			if inject && (v != "" || opts.Override) {
				_ = os.Setenv(k, v)
			}
		}
	}

	if len(opts.Required) > 0 {
		var missing []string
		for _, req := range opts.Required {
			if os.Getenv(req) == "" && effective[req] == "" {
				missing = append(missing, req)
			}
		}
		if len(missing) > 0 {
			svc := opts.Service
			if svc == "" {
				svc = "default"
			}
			return nil, fmt.Errorf("[service=%s] missing required environment variables (%s) after checking %s",
				svc, strings.Join(missing, ", "), target)
		}
	}

	return &Env{
		envPath: target,
		values:  effective,
	}, nil
}
