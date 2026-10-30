//go:build !windows

package processsupervisor

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJobPathStillRejectsFileSymlink(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	link := filepath.Join(directory, "linked-request.json")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if _, err := canonicalJobRequestPath(link); err == nil {
		t.Fatal("file symlink accepted")
	}
	if _, _, _, _, err := readJobRequest(link); err == nil {
		t.Fatal("file symlink reached job execution parsing")
	}
	if err := InspectJobOwner(link); err == nil {
		t.Fatal("file symlink reached historical owner inspection")
	}
}

func TestJobPathRejectsDirectorySymlinkBeforeParentTraversal(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(outside, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "request.json")
	if err := os.WriteFile(outsideFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "linked-directory")
	if err := os.Symlink(child, link); err != nil {
		t.Fatal(err)
	}
	// Join would erase the counterexample before it reaches the validator.
	requestFile := link + "/../request.json"
	resolved, err := filepath.EvalSymlinks(requestFile)
	if err != nil || resolved != outsideFile || filepath.Clean(requestFile) != file {
		t.Fatalf("invalid counterexample: resolved=%q clean=%q err=%v", resolved, filepath.Clean(requestFile), err)
	}
	if _, err := canonicalJobRequestPath(requestFile); err == nil {
		t.Error("directory symlink followed by parent traversal accepted")
	}
	if _, _, _, _, err := readJobRequest(requestFile); err == nil {
		t.Error("outside request reached job execution parsing")
	}
	if err := InspectJobOwner(requestFile); err == nil {
		t.Error("outside path reached historical owner inspection")
	}
	for _, dir := range []string{directory, outside} {
		if _, err := os.Stat(filepath.Join(dir, "claim.json")); !os.IsNotExist(err) {
			t.Errorf("path validation created claim in %q: %v", dir, err)
		}
	}
}
