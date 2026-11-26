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
	request := os.Getenv("HEAD_JOB_TEST_REQUEST")
	if delay, err := time.ParseDuration(os.Getenv("HEAD_JOB_TEST_SLOW_FLUSH")); err == nil {
		flushLog := os.Getenv("HEAD_JOB_TEST_FLUSH_LOG")
		flushSpool = func(file *os.File) error {
			// Log which spool is flushed and whether a terminal record already
			// vouches for it, so the test can pin the order.
			_, terminalErr := os.Lstat(filepath.Join(filepath.Dir(file.Name()), "terminal.json"))
			line := fmt.Sprintf("%s terminal=%t\n", filepath.Base(file.Name()), terminalErr == nil)
			if log, err := os.OpenFile(flushLog, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600); err == nil {
				_, _ = log.WriteString(line)
				_ = log.Close()
			}
			time.Sleep(delay)
			return file.Sync()
		}
	}
	code, err := RunJob(request)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		// A detached owner's stderr is not kept. Test-only: leave its error next
		// to the request so a failing assertion can name it.
		_ = os.WriteFile(filepath.Join(filepath.Dir(request), ownerErrorTestFile), []byte(err.Error()), 0600)
	}
	os.Exit(code)
}

const ownerErrorTestFile = "owner-error.test.txt"

// ownerErrorForTest returns the detached owner's error, when it reported one.
func ownerErrorForTest(directory string) string {
	data, err := os.ReadFile(filepath.Join(directory, ownerErrorTestFile))
	if err != nil {
		return "<no owner error recorded>"
	}
	return string(data)
}

// jobEvidence names what a job left behind, for failure messages: the owner's
// error and output, its exit state, and the job's records and spools. owner is
// nil for a detached owner, whose output is not kept.
func jobEvidence(directory string, owner *exec.Cmd) string {
	parts := []string{"owner error: " + ownerErrorForTest(directory)}
	if owner != nil {
		if output, ok := owner.Stderr.(*os.File); ok {
			parts = append(parts, "owner output: "+evidenceTail(output.Name()))
		}
		if owner.ProcessState != nil {
			parts = append(parts, "owner state: "+owner.ProcessState.String())
		}
	}
	for _, name := range []string{"terminal.json", "launch-failure.json", "control.jsonl", "stdout.bin", "stderr.bin"} {
		parts = append(parts, name+": "+evidenceTail(filepath.Join(directory, name)))
	}
	return strings.Join(parts, "; ")
}

func evidenceTail(file string) string {
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return "<absent>"
	}
	if err != nil {
		return "<unreadable: " + err.Error() + ">"
	}
	const limit = 2000
	if len(data) > limit {
		return fmt.Sprintf("...%q", data[len(data)-limit:])
	}
	return fmt.Sprintf("%q", data)
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
	if err := enterFrontendJob(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
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
		t.Fatalf("fixture did not establish live overlap after launcher exit; %s", jobEvidence(directory, nil))
	}
	deadline := time.Now().Add(7 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "terminal.json")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("detached job lost after frontend exit; %s", jobEvidence(directory, nil))
		}
		time.Sleep(20 * time.Millisecond)
	}
	terminal := readJobTerminal(t, directory)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput {
		t.Fatalf("bad detached terminal: %+v; %s", terminal, jobEvidence(directory, nil))
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

func startJobFixture(t *testing.T, directory, file string, environment ...string) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestJobOwnerHelper$")
	command.Dir = directory
	command.Env = append(append(os.Environ(), "HEAD_JOB_TEST_HELPER=owner", "HEAD_JOB_TEST_REQUEST="+file), environment...)
	// The owner's output goes to a file outside the job directory, so that
	// jobEvidence can show it and Wait never waits on a copy of the pipe.
	output, err := os.CreateTemp(t.TempDir(), "owner-output-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	command.Stdout, command.Stderr = output, output
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), command.Args, directory)
	err = command.Start()
	_ = output.Close()
	if err != nil {
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
		t.Fatalf("%v; %s", err, jobEvidence(directory, nil))
	}
	var terminal jobTerminal
	if err := json.Unmarshal(data, &terminal); err != nil {
		t.Fatalf("%v; %s", err, jobEvidence(directory, nil))
	}
	return terminal
}

func TestJobDurableResultAndNoRelaunch(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	command := startJobFixture(t, directory, file)
	if err := command.Wait(); err != nil {
		t.Fatalf("%v; %s", err, jobEvidence(directory, command))
	}
	t.Logf("exited pid=%d", command.Process.Pid)
	terminal := readJobTerminal(t, directory)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput || !terminal.OwnerExitRequired {
		t.Fatalf("bad terminal: %+v; %s", terminal, jobEvidence(directory, command))
	}
	before, err := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != "synthetic-result\n" {
		t.Fatalf("unexpected output %q; %s", before, jobEvidence(directory, command))
	}
	replay := startJobFixture(t, directory, file)
	if replay.Wait() == nil {
		t.Fatalf("claimed job relaunched; %s", jobEvidence(directory, replay))
	}
	after, _ := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if string(after) != string(before) {
		t.Fatal("replay changed stored output")
	}
}

// The owner's output grace (100 ms in the fixture) bounds how long output may
// stay open after the provider exits. A slow flush of the owner's own spool is
// not open output: a provider that exited with all of its output must still end
// as exited with complete output. Both spools are still flushed, once each,
// before the terminal record vouches for them.
func TestJobSlowSpoolFlushStillCompletes(t *testing.T) {
	directory, file := jobFixture(t, "success", 5000, 1024)
	flushLog := filepath.Join(t.TempDir(), "flush.log")
	command := startJobFixture(t, directory, file, "HEAD_JOB_TEST_SLOW_FLUSH=300ms", "HEAD_JOB_TEST_FLUSH_LOG="+flushLog)
	if err := command.Wait(); err != nil {
		t.Fatalf("slow spool flush failed the job: %v; %s", err, jobEvidence(directory, command))
	}
	terminal := readJobTerminal(t, directory)
	if terminal.ExitCode != 0 || terminal.Reason != "exited" || !terminal.CompleteOutput {
		t.Fatalf("slow spool flush changed the terminal: %+v; %s", terminal, jobEvidence(directory, command))
	}
	if output, err := os.ReadFile(filepath.Join(directory, "stdout.bin")); err != nil || string(output) != "synthetic-result\n" {
		t.Fatalf("incomplete output %q (%v); %s", output, err, jobEvidence(directory, command))
	}
	flushes, err := os.ReadFile(flushLog)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if expected := "stdout.bin terminal=false\nstderr.bin terminal=false\n"; string(flushes) != expected {
		t.Fatalf("spool flushes %q, expected %q; %s", flushes, expected, jobEvidence(directory, command))
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
				t.Fatalf("stopped job reported success; %s", jobEvidence(directory, command))
			}
			terminal := readJobTerminal(t, directory)
			if terminal.ExitCode == 0 || terminal.Reason != reason {
				t.Fatalf("bad stop evidence: %+v; %s", terminal, jobEvidence(directory, command))
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
		t.Fatalf("overflow misclassified: %+v; %s", terminal, jobEvidence(directory, command))
	}
	data, _ := os.ReadFile(filepath.Join(directory, "stdout.bin"))
	if !strings.EqualFold(string(data), "synt") {
		t.Fatalf("wrong bounded output: %q; %s", data, jobEvidence(directory, command))
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
				t.Fatalf("nested fixture did not publish owned port; %s", jobEvidence(directory, owner))
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
				t.Fatalf("deadline was not preserved; %s", jobEvidence(directory, owner))
			}
			t.Logf("owned-tree-exited owner=%d child=%d grandchild=%d portReleased=true", owner.Process.Pid, grandchild.ParentPID, grandchild.PID)
		})
	}
}
