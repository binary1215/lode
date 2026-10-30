package processsupervisor

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExactOwnerStateDoesNotConfuseReusedPID(t *testing.T) {
	for _, fixture := range []struct{ token, state, expected string }{
		{"generation-a", "present", "present"}, {"", "gone", "gone"},
		{"generation-b", "present", "reused"}, {"", "unknown", "unknown"},
		{"generation-a", "unknown", "unknown"},
	} {
		actual := exactOwnerState(123, "generation-a", func(int) (string, string) { return fixture.token, fixture.state })
		if actual != fixture.expected {
			t.Fatalf("%+v: got %s", fixture, actual)
		}
	}
	if exactOwnerState(123, "", func(int) (string, string) { t.Fatal("unbound probe"); return "", "gone" }) != "unknown" {
		t.Fatal("missing generation was inferred")
	}
}

func TestHistoricalInspectionDoesNotRequireRetiredExecutable(t *testing.T) {
	directory, file := jobFixture(t, "overlap", 1000, 1024)
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var job JobRequest
	if err := json.Unmarshal(data, &job); err != nil {
		t.Fatal(err)
	}
	job.Request.Executable = filepath.Join(directory, "retired-executable")
	data, err = json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	if err := writeJobRecord(filepath.Join(directory, "claim.json"), map[string]any{
		"requestDigest": hex.EncodeToString(hash[:]), "pid": os.Getpid(), "ownerToken": ownProcessToken(),
	}); err != nil {
		t.Fatal(err)
	}
	// This fixture only tests read-only parsing/probing, not a completed execution.
	if err := InspectJobOwner(file); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := readJobRequest(file); err == nil {
		t.Fatal("launch accepted a retired executable")
	}
}
