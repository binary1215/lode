//go:build linux

package processsupervisor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

type earlyStopProcessIdentity struct {
	pid   int
	group int
	birth string
	state string
}

func readEarlyStopIdentity(pid int) (earlyStopProcessIdentity, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return earlyStopProcessIdentity{}, err
	}
	tail := strings.LastIndex(string(raw), ")")
	if tail < 0 {
		return earlyStopProcessIdentity{}, fmt.Errorf("unreadable owned process identity")
	}
	fields := strings.Fields(string(raw)[tail+1:])
	if len(fields) < 20 {
		return earlyStopProcessIdentity{}, fmt.Errorf("incomplete owned process identity")
	}
	group, err := strconv.Atoi(fields[2])
	if err != nil {
		return earlyStopProcessIdentity{}, err
	}
	return earlyStopProcessIdentity{pid: pid, group: group, birth: fields[19], state: fields[0]}, nil
}

func earlyStopIdentityGone(identity earlyStopProcessIdentity) bool {
	current, err := readEarlyStopIdentity(identity.pid)
	return os.IsNotExist(err) || err == nil && current.birth != identity.birth
}

// Hold the exact ownership publication boundary until the parent has delivered
// SIGTERM and the subscription has acknowledged it. This is a deterministic
// startup race test, not a sleep before an ordinary later interrupt.
type earlyStopWriter struct {
	file *os.File
	dir  string
}

func (writer earlyStopWriter) Write(data []byte) (int, error) {
	n, err := writer.file.Write(data)
	if err != nil {
		return n, err
	}
	var event controlEvent
	if json.Unmarshal(data, &event) == nil && event.Type == "provider.started" {
		if err := os.WriteFile(filepath.Join(writer.dir, "ownership"), []byte(strconv.Itoa(event.ProviderPID)), 0o600); err != nil {
			return n, err
		}
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(writer.dir, "release")); err == nil {
				return n, nil
			}
			time.Sleep(time.Millisecond)
		}
		return n, fmt.Errorf("test ownership boundary was not released")
	}
	return n, nil
}

func TestEarlyStopOwnerHelper(t *testing.T) {
	dir := os.Getenv("LODE_EARLY_STOP_OWNER")
	if dir == "" {
		return
	}
	var request Request
	if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
		os.Exit(9)
	}
	input, err := validateRequest(request)
	if err != nil {
		os.Exit(10)
	}
	file, err := os.OpenFile(request.ControlFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		os.Exit(11)
	}
	controller, err := newPlatformController()
	if err != nil {
		os.Exit(12)
	}
	events := &eventWriter{encoder: json.NewEncoder(earlyStopWriter{file: file, dir: dir}), sync: file.Sync}
	subscribe := func() (<-chan os.Signal, func()) {
		incoming, unsubscribe := subscribeStopSignals()
		delivered := make(chan os.Signal, 1)
		done := make(chan struct{})
		go func() {
			select {
			case value := <-incoming:
				_ = os.WriteFile(filepath.Join(dir, "signal-captured"), []byte("captured"), 0o600)
				delivered <- value
			case <-done:
			}
		}()
		return delivered, func() { unsubscribe(); close(done) }
	}
	code, runErr := runOwnedProvider(request, bytes.NewReader(input), nil, os.Stdout, os.Stderr, nil, nil, controller, events, subscribe)
	_ = file.Close()
	if runErr != nil {
		fmt.Fprintln(os.Stderr, runErr)
		os.Exit(13)
	}
	os.Exit(code)
}

func TestEarlyStopProviderHelper(t *testing.T) {
	dir := os.Getenv("LODE_EARLY_STOP_PROVIDER")
	if dir == "" {
		return
	}
	if os.Getenv("LODE_EARLY_STOP_IGNORE") == "1" {
		signal.Ignore(os.Interrupt, syscall.SIGTERM)
		executable, _ := os.Executable()
		child := exec.Command(executable, "-test.run=^TestEarlyStopGrandchildHelper$")
		child.Env = append(os.Environ(), "LODE_EARLY_STOP_GRANDCHILD="+dir)
		child.Stdout, child.Stderr = io.Discard, io.Discard
		if err := child.Start(); err != nil {
			os.Exit(14)
		}
		_ = os.WriteFile(filepath.Join(dir, "descendant"), []byte(strconv.Itoa(child.Process.Pid)), 0o600)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestEarlyStopGrandchildHelper(t *testing.T) {
	dir := os.Getenv("LODE_EARLY_STOP_GRANDCHILD")
	if dir == "" {
		return
	}
	signal.Ignore(os.Interrupt, syscall.SIGTERM)
	_ = os.WriteFile(filepath.Join(dir, "descendant-ready"), []byte("ready"), 0o600)
	for {
		time.Sleep(time.Second)
	}
}

func TestOwnershipPublicationAlreadyBuffersStopAndForceCleansIgnoringTree(t *testing.T) {
	for _, ignore := range []bool{false, true} {
		t.Run(fmt.Sprint(ignore), func(t *testing.T) {
			dir := t.TempDir()
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			request := Request{SchemaVersion: 1, ProtocolVersion: ProtocolVersion, Executable: executable,
				Arguments: []string{"-test.run=^TestEarlyStopProviderHelper$"}, WorkingDirectory: dir,
				Environment: map[string]string{"LODE_EARLY_STOP_PROVIDER": dir, "LODE_EARLY_STOP_IGNORE": map[bool]string{true: "1", false: "0"}[ignore]},
				InputBase64: "", ControlFile: filepath.Join(dir, "control.jsonl"), TerminationGraceMS: 500}
			raw, _ := json.Marshal(request)
			owner := exec.Command(executable, "-test.run=^TestEarlyStopOwnerHelper$")
			owner.Env = append(os.Environ(), "LODE_EARLY_STOP_OWNER="+dir)
			owner.Stdin = bytes.NewReader(raw)
			var stderr bytes.Buffer
			owner.Stdout, owner.Stderr = io.Discard, &stderr
			if err := owner.Start(); err != nil {
				t.Fatal(err)
			}
			t.Logf("CHILD_START owner=%d parent=%d command=early-stop-owner cwd=%s ports=none", owner.Process.Pid, os.Getpid(), dir)
			exited := make(chan error, 1)
			go func() { exited <- owner.Wait() }()
			providerPID := 0
			finished := false
			cleanupVerified := false
			var owned []earlyStopProcessIdentity
			t.Cleanup(func() {
				if !cleanupVerified {
					// Recheck birth and the exact owned group before failure
					// cleanup. Reused/unattributed PIDs are never signalled.
					for _, identity := range owned {
						current, err := readEarlyStopIdentity(identity.pid)
						if err == nil && current.birth == identity.birth && current.group == providerPID && current.state != "Z" {
							_ = syscall.Kill(-providerPID, syscall.SIGKILL)
							break
						}
					}
				}
				if !finished {
					_ = owner.Process.Kill()
					select {
					case <-exited:
					case <-time.After(3 * time.Second):
						t.Error("owned early-stop helper did not exit")
					}
				}
			})
			await := func(name string) []byte {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					if value, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
						return value
					}
					select {
					case err := <-exited:
						finished = true
						t.Fatalf("owner exited before %s: %v, stderr=%s", name, err, stderr.String())
					default:
					}
					time.Sleep(time.Millisecond)
				}
				t.Fatalf("no %s evidence", name)
				return nil
			}
			providerPID, err = strconv.Atoi(string(await("ownership")))
			if err != nil || providerPID < 1 {
				t.Fatal("invalid owned provider identity")
			}
			provider, err := readEarlyStopIdentity(providerPID)
			if err != nil || provider.group != providerPID {
				t.Fatal("provider ownership could not be attributed")
			}
			owned = append(owned, provider)
			t.Logf("CHILD_START provider=%d parent=%d group=%d birth=%s cwd=%s ports=none", providerPID, owner.Process.Pid, provider.group, provider.birth, dir)
			if ignore {
				await("descendant-ready")
				pid, err := strconv.Atoi(string(await("descendant")))
				if err != nil {
					t.Fatal(err)
				}
				descendant, err := readEarlyStopIdentity(pid)
				if err != nil || descendant.group != providerPID {
					t.Fatal("descendant ownership could not be attributed")
				}
				owned = append(owned, descendant)
				t.Logf("CHILD_START descendant=%d parent=%d group=%d birth=%s cwd=%s ports=none", pid, providerPID, descendant.group, descendant.birth, dir)
			}
			if err := owner.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			await("signal-captured")
			if err := os.WriteFile(filepath.Join(dir, "release"), []byte("release"), 0o600); err != nil {
				t.Fatal(err)
			}
			select {
			case <-exited:
				finished = true
			case <-time.After(5 * time.Second):
				t.Fatal("owner did not finish bounded stop")
			}
			var cleanup controlEvent
			control, _ := os.ReadFile(request.ControlFile)
			for _, line := range bytes.Split(control, []byte{'\n'}) {
				var event controlEvent
				if json.Unmarshal(line, &event) == nil && event.Type == "supervisor.cleanup" {
					cleanup = event
				}
			}
			// A group already gone after Terminate needs no additional cleanup
			// attempt; verification and actual identity disappearance are required.
			if !cleanup.CleanupVerified || ignore && !cleanup.ForceUsed {
				t.Fatalf("stop did not retain exact cleanup evidence: %+v, stderr=%s", cleanup, stderr.String())
			}
			for _, identity := range owned {
				deadline := time.Now().Add(2 * time.Second)
				for !earlyStopIdentityGone(identity) && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				if !earlyStopIdentityGone(identity) {
					t.Fatalf("owned process identity remains: %+v", identity)
				}
				t.Logf("CHILD_END pid=%d birth=%s signal=owned-tree-cleanup-verified ports=none", identity.pid, identity.birth)
			}
			t.Logf("CHILD_END owner=%d exit=observed ports=none", owner.Process.Pid)
			cleanupVerified = true
		})
	}
}
