package processsupervisor

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJobOwnerHelper(t *testing.T) {
	if os.Getenv("HEAD_JOB_TEST_HELPER") != "owner" {
		return
	}
	code, err := RunJob(os.Getenv("HEAD_JOB_TEST_REQUEST"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(code)
}

func TestJobProviderHelper(t *testing.T) {
	if os.Getenv("HEAD_JOB_TEST_HELPER") != "provider" {
		return
	}
	if os.Getenv("HEAD_JOB_TEST_MODE") == "port-child" {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(3)
		}
		defer listener.Close()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"pid": os.Getpid(), "parentPid": os.Getppid(), "address": listener.Addr().String()})
		for {
			time.Sleep(time.Second)
		}
	}
	if os.Getenv("HEAD_JOB_TEST_MODE") == "nested-port" {
		child := exec.Command(os.Args[0], "-test.run=^TestJobProviderHelper$")
		child.Env = append(os.Environ(), "HEAD_JOB_TEST_MODE=port-child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(4)
		}
		_ = child.Wait()
		os.Exit(0)
	}
	if os.Getenv("HEAD_JOB_TEST_MODE") == "wait" {
		time.Sleep(10 * time.Second)
	}
	if os.Getenv("HEAD_JOB_TEST_MODE") == "overlap" {
		time.Sleep(500 * time.Millisecond)
	}
	fmt.Print("synthetic-result\n")
	os.Exit(0)
}

func TestJobLauncherHelper(t *testing.T) {
	if os.Getenv("HEAD_JOB_TEST_HELPER") != "launcher" {
		return
	}
	file := os.Getenv("HEAD_JOB_TEST_REQUEST")
	if err := launchJob(file, os.Args[0], []string{"-test.run=^TestJobOwnerHelper$"}, []string{"HEAD_JOB_TEST_HELPER=owner"}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

func TestJobSurvivesFrontendExitAndDoesNotRelaunch(t *testing.T) {
	if !DetachedJobOwnerSupported {
		t.Skip("detached nested cleanup is not verified on this platform; attached path remains available")
	}
	directory, file := jobFixture(t, "overlap", 5000, 1024)
	launcher := exec.Command(os.Args[0], "-test.run=^TestJobLauncherHelper$")
	launcher.Dir = directory
	launcher.Env = append(os.Environ(), "HEAD_JOB_TEST_HELPER=launcher", "HEAD_JOB_TEST_REQUEST="+file)
	var output bytes.Buffer
	launcher.Stdout = &output
	launcher.Stderr = &output
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), launcher.Args, directory)
	if err := launcher.Start(); err != nil {
		t.Fatal(err)
	}
	t.Logf("launcher-start pid=%d parent=%d", launcher.Process.Pid, os.Getpid())
	if err := launcher.Wait(); err != nil {
		t.Fatalf("detached launch failed: %v %s", err, output.String())
	}
	t.Logf("launcher-exited pid=%d ack=%s", launcher.Process.Pid, output.String())
	var ack struct {
		OwnerPID int `json:"ownerPid"`
	}
	if err := json.Unmarshal(output.Bytes(), &ack); err != nil || ack.OwnerPID <= 0 {
		t.Fatalf("invalid launch acknowledgment: %s", output.String())
	}
	t.Cleanup(func() {
		if _, err := os.Stat(filepath.Join(directory, "terminal.json")); os.IsNotExist(err) {
			_ = os.WriteFile(filepath.Join(directory, "cancel"), nil, 0600)
			deadline := time.Now().Add(7 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(filepath.Join(directory, "terminal.json")); err == nil {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			t.Errorf("owned job %d did not publish terminal after cancellation", ack.OwnerPID)
		}
	})
	if _, err := os.Stat(filepath.Join(directory, "terminal.json")); err == nil {
		t.Fatal("fixture did not establish live overlap after launcher exit")
	}
	deadline := time.Now().Add(7 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "terminal.json")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("detached job lost after frontend exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
	terminal := readJobTerminal(t, directory)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput {
		t.Fatalf("bad detached terminal: %+v", terminal)
	}
	// Launch retry must not create a second owner, even after terminal success.
	if err := launchJob(file, os.Args[0], nil, nil); err == nil {
		t.Fatal("launch replay was accepted")
	}
	t.Logf("detached-owner-terminal pid=%d requestDigest=%s", ack.OwnerPID, terminal.RequestDigest)
}

func jobFixture(t *testing.T, mode string, timeout int, outputLimit int64) (string, string) {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{"HEAD_JOB_TEST_HELPER": "provider", "HEAD_JOB_TEST_MODE": mode}
	for _, key := range []string{"SystemRoot", "WINDIR", "TMP", "TEMP", "PATH"} {
		if value := os.Getenv(key); value != "" {
			environment[key] = value
		}
	}
	request := JobRequest{ProtocolVersion: JobProtocolVersion, TimeoutMS: timeout, DeadlineUnixMS: time.Now().Add(time.Duration(timeout) * time.Millisecond).UnixMilli(), MaxStdoutBytes: outputLimit, MaxStderrBytes: 1024,
		Request: Request{SchemaVersion: 1, ProtocolVersion: ProtocolVersion, Executable: executable,
			Arguments: []string{"-test.run=^TestJobProviderHelper$"}, WorkingDirectory: directory,
			Environment: environment, InputBase64: base64.StdEncoding.EncodeToString([]byte("selected context")),
			ControlFile: filepath.Join(directory, "control.jsonl"), TerminationGraceMS: 100}}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, "request.json")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	return directory, file
}

func startJobFixture(t *testing.T, directory, file string) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestJobOwnerHelper$")
	command.Dir = directory
	command.Env = append(os.Environ(), "HEAD_JOB_TEST_HELPER=owner", "HEAD_JOB_TEST_REQUEST="+file)
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), command.Args, directory)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Logf("started pid=%d parent=%d", command.Process.Pid, os.Getpid())
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	return command
}

func readJobTerminal(t *testing.T, directory string) jobTerminal {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "terminal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var terminal jobTerminal
	if err := json.Unmarshal(data, &terminal); err != nil {
		t.Fatal(err)
	}
	return terminal
}

func TestJobDurableResultAndNoRelaunch(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	command := startJobFixture(t, directory, file)
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	t.Logf("exited pid=%d", command.Process.Pid)
	terminal := readJobTerminal(t, directory)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput || !terminal.OwnerExitRequired {
		t.Fatalf("bad terminal: %+v", terminal)
	}
	before, err := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != "synthetic-result\n" {
		t.Fatalf("unexpected output %q", before)
	}
	replay := startJobFixture(t, directory, file)
	if replay.Wait() == nil {
		t.Fatal("claimed job relaunched")
	}
	after, _ := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if string(after) != string(before) {
		t.Fatal("replay changed stored output")
	}
}

func TestJobOwnerEnforcesDeadlineAndCancel(t *testing.T) {
	for _, reason := range []string{"timeout", "cancel"} {
		t.Run(reason, func(t *testing.T) {
			timeout := 5000
			if reason == "timeout" {
				timeout = 100
			}
			directory, file := jobFixture(t, "wait", timeout, 1024)
			if reason == "cancel" {
				if err := os.WriteFile(filepath.Join(directory, "cancel"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			command := startJobFixture(t, directory, file)
			if command.Wait() == nil {
				t.Fatal("stopped job reported success")
			}
			terminal := readJobTerminal(t, directory)
			if terminal.ExitCode == 0 || terminal.Reason != reason {
				t.Fatalf("bad stop evidence: %+v", terminal)
			}
		})
	}
}

func TestJobOutputBound(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 4)
	command := startJobFixture(t, directory, file)
	_ = command.Wait()
	terminal := readJobTerminal(t, directory)
	if terminal.CompleteOutput || terminal.Reason != "output-limit" || terminal.StdoutBytes != 4 {
		t.Fatalf("overflow misclassified: %+v", terminal)
	}
	data, _ := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if !strings.EqualFold(string(data), "synt") {
		t.Fatalf("wrong bounded output: %q", data)
	}
}

func TestJobOwnerCrashAndDeadlineCleanGrandchildPort(t *testing.T) {
	if !DetachedJobOwnerSupported {
		t.Skip("requires verified Windows nested Job Object ownership")
	}
	for _, mode := range []string{"crash", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			timeout := 5000
			if mode == "deadline" {
				timeout = 1500
			}
			directory, file := jobFixture(t, "nested-port", timeout, 1024)
			owner := startJobFixture(t, directory, file)
			var grandchild struct {
				PID       int    `json:"pid"`
				ParentPID int    `json:"parentPid"`
				Address   string `json:"address"`
			}
			deadline := time.Now().Add(4 * time.Second)
			for grandchild.PID == 0 && time.Now().Before(deadline) {
				data, _ := os.ReadFile(filepath.Join(directory, "stdout.bin"))
				_ = json.Unmarshal(data, &grandchild)
				if grandchild.PID == 0 {
					time.Sleep(10 * time.Millisecond)
				}
			}
			if grandchild.PID == 0 {
				t.Fatal("nested fixture did not publish owned port")
			}
			t.Logf("owned-grandchild pid=%d parent=%d address=%s", grandchild.PID, grandchild.ParentPID, grandchild.Address)
			if mode == "crash" {
				// Deliberate crash injection of this exact owned fixture. Windows
				// has no portable graceful console signal for the hidden test owner.
				if err := owner.Process.Signal(os.Interrupt); err != nil {
					_ = owner.Process.Kill()
				}
			}
			_ = owner.Wait()
			if err := waitOwnedFixtureExit(grandchild.PID); err != nil {
				t.Fatal(err)
			}
			if err := waitOwnedFixtureExit(grandchild.ParentPID); err != nil {
				t.Fatal(err)
			}
			connection, err := net.DialTimeout("tcp", grandchild.Address, 200*time.Millisecond)
			if err == nil {
				connection.Close()
				t.Fatal("owned grandchild port survived owner cleanup")
			}
			if mode == "crash" {
				if _, err := os.Stat(filepath.Join(directory, "terminal.json")); err == nil {
					t.Fatal("crashed owner invented terminal completion")
				}
			} else if readJobTerminal(t, directory).Reason != "timeout" {
				t.Fatal("deadline was not preserved")
			}
			t.Logf("owned-tree-exited owner=%d child=%d grandchild=%d portReleased=true", owner.Process.Pid, grandchild.ParentPID, grandchild.PID)
		})
	}
}
