package envkit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseAndRedaction(t *testing.T) {
	sample := `
# Comment line
SYNTH_GO_TOKEN=ghp_mock_secret_1234567890
SYNTH_GO_PROJECT=aphrody # inline comment
export MULTI_LINE="hello\nworld\t\"ok\""
SINGLE_Q='raw \n # literal'
`
	parsed := ParseDotEnv(sample)
	if parsed["SYNTH_GO_TOKEN"] != "ghp_mock_secret_1234567890" {
		t.Fatalf("unexpected SYNTH_GO_TOKEN: %q", parsed["SYNTH_GO_TOKEN"])
	}
	if parsed["SYNTH_GO_PROJECT"] != "aphrody" {
		t.Fatalf("unexpected SYNTH_GO_PROJECT: %q", parsed["SYNTH_GO_PROJECT"])
	}
	if parsed["MULTI_LINE"] != "hello\nworld\t\"ok\"" {
		t.Fatalf("unexpected MULTI_LINE: %q", parsed["MULTI_LINE"])
	}
	if parsed["SINGLE_Q"] != `raw \n # literal` {
		t.Fatalf("unexpected SINGLE_Q: %q", parsed["SINGLE_Q"])
	}

	tmpDir := t.TempDir()
	envFile := filepath.Join(tmpDir, ".env")
	if err := os.WriteFile(envFile, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}

	_ = os.Setenv("SYNTH_GO_PROJECT", "override_preserved")
	defer os.Unsetenv("SYNTH_GO_PROJECT")

	loaded, err := LoadWithOptions(Options{
		EnvPath:          envFile,
		Service:          "go-test",
		Required:         []string{"SYNTH_GO_TOKEN", "SYNTH_GO_PROJECT"},
		Override:         false,
		InjectProcessEnv: false,
	})
	if err != nil {
		t.Fatalf("LoadWithOptions failed: %v", err)
	}

	if got := loaded.Get("SYNTH_GO_PROJECT"); got != "override_preserved" {
		t.Fatalf("expected existing process env to win, got %q", got)
	}

	strOut := loaded.String()
	if strings.Contains(strOut, "ghp_mock_secret_1234567890") {
		t.Fatalf("String() leaked secret: %s", strOut)
	}
	if !strings.Contains(strOut, "SET [len=26]") {
		t.Fatalf("expected masked length in String(), got: %s", strOut)
	}

	jsonBytes, err := json.Marshal(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(jsonBytes), "ghp_mock_secret_1234567890") {
		t.Fatalf("MarshalJSON() leaked secret")
	}
}
