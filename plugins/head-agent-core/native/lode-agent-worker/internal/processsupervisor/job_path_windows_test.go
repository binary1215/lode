package processsupervisor

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func shortJobPath(t *testing.T, value string) string {
	t.Helper()
	pointer, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	n, err := syscall.GetShortPathName(pointer, &buffer[0], uint32(len(buffer)))
	if err != nil || n == 0 || n >= uint32(len(buffer)) {
		t.Fatalf("short path lookup failed: length=%d err=%v", n, err)
	}
	return syscall.UTF16ToString(buffer[:n])
}

func TestWindowsJobPathPreservesHostSpellingAndDigest(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	shortDirectory := shortJobPath(t, directory)
	alias := filepath.Join(shortDirectory, filepath.Base(file))
	t.Logf("8.3 alias exercised=%t input=%q canonical=%q", alias != file, alias, file)
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var job JobRequest
	if err := json.Unmarshal(data, &job); err != nil {
		t.Fatal(err)
	}
	job.Request.ControlFile = filepath.Join(shortDirectory, "control.jsonl")
	data, err = json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	parsed, _, observed, retained, err := readJobRequest(alias)
	if err != nil || retained != alias || parsed.Request.ControlFile != job.Request.ControlFile || !bytes.Equal(observed, data) {
		t.Fatalf("Host input was rejected or rewritten: path=%q err=%v", retained, err)
	}
	command := startJobFixture(t, directory, alias)
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	t.Logf("exited pid=%d", command.Process.Pid)
	terminal := readJobTerminal(t, directory)
	digest := sha256.Sum256(data)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput || terminal.RequestDigest != hex.EncodeToString(digest[:]) {
		t.Fatalf("job did not preserve exact request: %+v", terminal)
	}
	if err := InspectJobOwner(alias); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(after, data) {
		t.Fatalf("request bytes changed: %v", err)
	}
}

func TestWindowsJobPathStillRejectsJunctionEscape(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	link := filepath.Join(t.TempDir(), "junction")
	command := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, directory)
	command.Dir = directory
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), command.Args, directory)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Logf("started pid=%d parent=%d", command.Process.Pid, os.Getpid())
	if err := command.Wait(); err != nil {
		t.Fatalf("junction fixture failed: %v %s", err, output.String())
	}
	t.Logf("exited pid=%d", command.Process.Pid)
	// Remove only the link itself; never recursively follow its target.
	t.Cleanup(func() { _ = os.Remove(link) })
	for _, parent := range []string{link, shortJobPath(t, link)} {
		alias := filepath.Join(parent, filepath.Base(file))
		if _, err := canonicalJobRequestPath(alias); err == nil {
			t.Fatalf("junction accepted: %q", alias)
		}
		if _, _, _, _, err := readJobRequest(alias); err == nil {
			t.Fatal("junction reached job execution parsing")
		}
		if err := InspectJobOwner(alias); err == nil {
			t.Fatal("junction reached historical owner inspection")
		}
	}
	if _, err := os.Stat(filepath.Join(directory, "claim.json")); !os.IsNotExist(err) {
		t.Fatalf("rejected alias created a claim or absence is unknown: %v", err)
	}
}
