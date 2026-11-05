package processsupervisor

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// RunInteractive must never run in the test runner itself: the Windows
// controller places its own process in a kill-on-close Job Object.
func TestInteractiveOwnerHelper(t *testing.T) {
	mode := os.Getenv("HEAD_INTERACTIVE_TEST_OWNER")
	if mode == "" {
		return
	}
	var code int
	var err error
	if mode == "oneshot" {
		code, err = Run(os.Stdin, os.Stdout, os.Stderr)
	} else if mode == "input-error" {
		code, err = RunInteractive(&interactiveErrorAtEOF{source: os.Stdin}, os.Stdout, os.Stderr)
	} else if mode == "input-error-after-child-exit" {
		reader := &interactiveErrorReleasedByClose{source: os.Stdin, released: make(chan struct{})}
		code, err = RunInteractive(reader, os.Stdout, os.Stderr)
	} else if mode == "regular-file" {
		var input *os.File
		input, err = os.Open("regular-input.bin")
		if err != nil {
			code = 8
		} else {
			code, err = RunInteractive(input, os.Stdout, os.Stderr)
			_ = input.Close()
		}
	} else {
		code, err = RunInteractive(os.Stdin, os.Stdout, os.Stderr)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(code)
}

var interactiveSyntheticInputError = errors.New("synthetic read failure at parent EOF")
var interactiveSyntheticDeferredInputError = errors.New("synthetic delivery error retained across owner shutdown")

// This error is not os.ErrClosed/io.ErrClosedPipe and cannot be discarded as
// the supervisor's own Close-unblock. The child simultaneously sees stdin EOF
// when the copy loop closes its pipe and can exit normally before Wait selects.
type interactiveErrorAtEOF struct {
	source io.ReadCloser
}

func (reader *interactiveErrorAtEOF) Read(data []byte) (int, error) {
	n, err := reader.source.Read(data)
	if err == io.EOF {
		return n, interactiveSyntheticInputError
	}
	return n, err
}

func (reader *interactiveErrorAtEOF) Close() error { return reader.source.Close() }

// Hold a prepared delivery error until the owner closes its input. With a
// normal early-exit child and an open parent pipe, inputFailed cannot be ready
// before the supervisor selects command.Wait. This deterministically exercises
// the final inputDone check rather than relying on scheduler timing.
type interactiveErrorReleasedByClose struct {
	source     io.ReadCloser
	headerDone bool
	released   chan struct{}
	closeOnce  sync.Once
}

func (reader *interactiveErrorReleasedByClose) Read(data []byte) (int, error) {
	if !reader.headerDone {
		n, err := reader.source.Read(data)
		reader.headerDone = bytes.IndexByte(data[:n], '\n') >= 0
		return n, err
	}
	<-reader.released
	return 0, interactiveSyntheticDeferredInputError
}

func (reader *interactiveErrorReleasedByClose) Close() error {
	var err error
	reader.closeOnce.Do(func() {
		close(reader.released)
		err = reader.source.Close()
	})
	return err
}

type interactiveProcessRecord struct {
	PID       int      `json:"pid"`
	ParentPID int      `json:"parentPid"`
	Command   []string `json:"command"`
	Directory string   `json:"workingDirectory"`
	Address   string   `json:"address,omitempty"`
}

func interactiveRecordProcess(name, address string) {
	directory, _ := os.Getwd()
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(8)
	}
	err = json.NewEncoder(file).Encode(interactiveProcessRecord{
		PID: os.Getpid(), ParentPID: os.Getppid(), Command: os.Args,
		Directory: directory, Address: address,
	})
	if closeErr := file.Close(); err != nil || closeErr != nil {
		os.Exit(9)
	}
}

func TestInteractiveProviderHelper(t *testing.T) {
	mode := os.Getenv("HEAD_INTERACTIVE_TEST_PROVIDER")
	if mode == "" {
		return
	}
	if mode == "port-child" {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(3)
		}
		defer listener.Close()
		interactiveRecordProcess("grandchild.json", listener.Addr().String())
		for {
			time.Sleep(time.Second)
		}
	}
	interactiveRecordProcess("child.json", "")
	switch mode {
	case "echo":
		fmt.Fprint(os.Stderr, "synthetic-stderr\n")
		if _, err := io.Copy(os.Stdout, os.Stdin); err != nil {
			os.Exit(4)
		}
	case "dialogue":
		reader := bufio.NewReader(os.Stdin)
		for {
			line, err := reader.ReadString('\n')
			if len(line) != 0 {
				fmt.Fprint(os.Stdout, "reply:"+line)
			}
			if err == io.EOF {
				fmt.Fprint(os.Stdout, "stdin-closed\n")
				break
			}
			if err != nil {
				os.Exit(5)
			}
		}
	case "exit":
		fmt.Fprint(os.Stdout, "child-exited\n")
	case "wait":
		fmt.Fprint(os.Stdout, "child-ready\n")
		for {
			time.Sleep(time.Second)
		}
	case "nested-port":
		child := exec.Command(os.Args[0], "-test.run=^TestInteractiveProviderHelper$")
		child.Env = append(os.Environ(), "HEAD_INTERACTIVE_TEST_PROVIDER=port-child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		directory, _ := os.Getwd()
		fmt.Fprintf(os.Stderr, "planned parent=%d command=%q cwd=%q ports=[loopback-ephemeral]\n", os.Getpid(), child.Args, directory)
		if err := child.Start(); err != nil {
			os.Exit(6)
		}
		fmt.Fprintf(os.Stderr, "started pid=%d parent=%d\n", child.Process.Pid, os.Getpid())
		_ = child.Wait()
	default:
		os.Exit(7)
	}
	os.Exit(0)
}

type interactiveBuffer struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (buffer *interactiveBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.data.Write(data)
}

func (buffer *interactiveBuffer) Bytes() []byte {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return bytes.Clone(buffer.data.Bytes())
}

type interactiveOwner struct {
	command *exec.Cmd
	input   io.WriteCloser
	stdout  interactiveBuffer
	stderr  interactiveBuffer
	done    chan struct{}
	waitErr error
}

func startInteractiveOwner(t *testing.T, directory, mode string) *interactiveOwner {
	return startInteractiveOwnerInput(t, directory, mode, nil, nil)
}

// A Unix socketpair exercises the same inherited stdin path used by libuv.
// Keep all process ownership and cleanup in the existing fixture owner.
func startInteractiveOwnerInput(t *testing.T, directory, mode string, source *os.File, writer io.WriteCloser) *interactiveOwner {
	t.Helper()
	owner := &interactiveOwner{done: make(chan struct{})}
	owner.command = exec.Command(os.Args[0], "-test.run=^TestInteractiveOwnerHelper$")
	owner.command.Dir = directory
	owner.command.Env = append(os.Environ(), "HEAD_INTERACTIVE_TEST_OWNER="+mode)
	owner.command.Stdout, owner.command.Stderr = &owner.stdout, &owner.stderr
	var err error
	if source == nil {
		owner.input, err = owner.command.StdinPipe()
	} else {
		defer source.Close()
		owner.command.Stdin, owner.input = source, writer
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("planned parent=%d command=%q cwd=%q ports=[]", os.Getpid(), owner.command.Args, directory)
	if err := owner.command.Start(); err != nil {
		_ = owner.input.Close()
		t.Fatal(err)
	}
	t.Logf("started pid=%d parent=%d", owner.command.Process.Pid, os.Getpid())
	go func() {
		owner.waitErr = owner.command.Wait()
		close(owner.done)
	}()
	t.Cleanup(func() {
		_ = owner.input.Close()
		select {
		case <-owner.done:
		case <-time.After(500 * time.Millisecond):
			// First request graceful termination of this exact test-owned owner.
			_ = owner.command.Process.Signal(os.Interrupt)
			select {
			case <-owner.done:
			case <-time.After(250 * time.Millisecond):
				_ = owner.command.Process.Kill()
				<-owner.done
			}
		}
		t.Logf("exited pid=%d", owner.command.Process.Pid)
	})
	return owner
}

func (owner *interactiveOwner) write(t *testing.T, data []byte, allowEarlyClose bool) {
	t.Helper()
	result := make(chan error, 1)
	go func() {
		_, err := owner.input.Write(data)
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil && !allowEarlyClose {
			t.Fatalf("interactive input write: %v; stderr=%s", err, owner.stderr.Bytes())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("interactive input write hung")
	}
}

func (owner *interactiveOwner) wait(t *testing.T, timeout time.Duration) error {
	t.Helper()
	select {
	case <-owner.done:
		return owner.waitErr
	case <-time.After(timeout):
		t.Fatalf("interactive owner did not exit within %s; stdout=%q stderr=%q", timeout, owner.stdout.Bytes(), owner.stderr.Bytes())
		return nil
	}
}

func (owner *interactiveOwner) awaitOutput(t *testing.T, expected string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if bytes.Contains(owner.stdout.Bytes(), []byte(expected)) {
			return
		}
		select {
		case <-owner.done:
			t.Fatalf("owner exited before %q; stdout=%q stderr=%q", expected, owner.stdout.Bytes(), owner.stderr.Bytes())
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("incremental output %q was not delivered before parent EOF; stdout=%q stderr=%q", expected, owner.stdout.Bytes(), owner.stderr.Bytes())
}

func interactiveFixture(t *testing.T, mode string, timeout int) (string, map[string]any) {
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
	environment := map[string]string{"HEAD_INTERACTIVE_TEST_PROVIDER": mode}
	for _, key := range []string{"SystemRoot", "WINDIR", "TMP", "TEMP", "PATH"} {
		if value := os.Getenv(key); value != "" {
			environment[key] = value
		}
	}
	request := Request{
		SchemaVersion: 1, ProtocolVersion: ProtocolVersion, Executable: executable,
		Arguments: []string{"-test.run=^TestInteractiveProviderHelper$"}, WorkingDirectory: directory,
		Environment: environment, InputBase64: "", ControlFile: filepath.Join(directory, "control.jsonl"),
		TerminationGraceMS: 100,
	}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	fields["interactiveProtocolVersion"] = "0.1.0"
	fields["timeoutMs"] = timeout
	return directory, fields
}

func interactiveHeader(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return append(data, '\n')
}

func readInteractiveEvents(t *testing.T, directory string) []controlEvent {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "control.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var events []controlEvent
	for {
		var event controlEvent
		if err := decoder.Decode(&event); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

func verifyInteractiveCleanup(t *testing.T, directory string, successful bool) {
	t.Helper()
	events := readInteractiveEvents(t, directory)
	if len(events) != 4 || events[0].Type != "supervisor.ready" || events[1].Type != "provider.started" ||
		events[2].Type != "provider.exited" || events[3].Type != "supervisor.cleanup" {
		t.Fatalf("unexpected ownership/terminal events: %+v", events)
	}
	if events[1].ProviderPID <= 0 || events[2].ProviderPID != events[1].ProviderPID || events[2].ExitCode == nil ||
		(*events[2].ExitCode == 0) != successful || !events[3].CleanupVerified {
		t.Fatalf("invalid provider terminal/cleanup evidence: %+v", events)
	}
	data, err := os.ReadFile(filepath.Join(directory, "child.json"))
	if err != nil {
		t.Fatal(err)
	}
	var record interactiveProcessRecord
	if err := json.Unmarshal(data, &record); err != nil || record.PID != events[1].ProviderPID {
		t.Fatalf("invalid child ownership record: %s", data)
	}
	t.Logf("owned-child-record %s", data)
	if DetachedJobOwnerSupported {
		if err := waitOwnedFixtureExit(record.PID); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInteractiveRejectsBootstrapBeforeStartingChild(t *testing.T) {
	cases := []struct {
		name string
		edit func(map[string]any)
		raw  func([]byte) []byte
	}{
		{name: "empty", raw: func([]byte) []byte { return nil }},
		{name: "malformed", raw: func([]byte) []byte { return []byte("{broken}\n") }},
		{name: "unknown-field", edit: func(fields map[string]any) { fields["launchAnything"] = true }},
		{name: "duplicate-field", raw: func(data []byte) []byte { return append([]byte("{\"timeoutMs\":5000,"), data[1:]...) }},
		{name: "null", edit: func(fields map[string]any) { fields["timeoutMs"] = nil }},
		{name: "null-environment", edit: func(fields map[string]any) { fields["environment"] = nil }},
		{name: "missing-lf", raw: func(data []byte) []byte { return data[:len(data)-1] }},
		{name: "trailing-json", raw: func(data []byte) []byte { return append(data[:len(data)-1], []byte(" {}\n")...) }},
		{name: "invalid-utf8", raw: func(data []byte) []byte { return append([]byte{0xff}, data...) }},
		{name: "oversized-header", raw: func([]byte) []byte { return append(bytes.Repeat([]byte(" "), maxRequestBytes), '\n') }},
		{name: "wrong-interactive-version", edit: func(fields map[string]any) { fields["interactiveProtocolVersion"] = "9" }},
		{name: "nonempty-oneshot-input", edit: func(fields map[string]any) { fields["inputBase64"] = "eA==" }},
		{name: "deadline-too-short", edit: func(fields map[string]any) { fields["timeoutMs"] = 99 }},
		{name: "deadline-too-long", edit: func(fields map[string]any) { fields["timeoutMs"] = 3600001 }},
		{name: "fractional-deadline", edit: func(fields map[string]any) { fields["timeoutMs"] = 100.5 }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			directory, fields := interactiveFixture(t, "echo", 5000)
			if test.edit != nil {
				test.edit(fields)
			}
			header := interactiveHeader(t, fields)
			if test.raw != nil {
				header = test.raw(header)
			}
			owner := startInteractiveOwner(t, directory, "interactive")
			owner.write(t, header, true)
			_ = owner.input.Close()
			if owner.wait(t, 5*time.Second) == nil || owner.command.ProcessState.ExitCode() != 2 {
				t.Fatalf("bad bootstrap did not exit 2: stdout=%q stderr=%q", owner.stdout.Bytes(), owner.stderr.Bytes())
			}
			if len(owner.stdout.Bytes()) != 0 || len(owner.stderr.Bytes()) == 0 {
				t.Fatal("invalid bootstrap returned child output or no diagnostic")
			}
			for _, name := range []string{"control.jsonl", "child.json", "grandchild.json"} {
				if _, err := os.Stat(filepath.Join(directory, name)); !os.IsNotExist(err) {
					t.Fatalf("invalid bootstrap created %s or absence is unverified: %v", name, err)
				}
			}
		})
	}
}

func TestInteractiveCoalescedBootstrapAndBinaryStream(t *testing.T) {
	directory, fields := interactiveFixture(t, "echo", 10000)
	owner := startInteractiveOwner(t, directory, "interactive")
	// This exceeds the one-shot input bound and includes binary bytes/newlines.
	// Interactive transport streams bytes; it does not reparse or base64 them.
	payload := bytes.Repeat([]byte{0, 0xff, '\n', '\r', '{', '}', 'x'}, 750000)
	owner.write(t, append(interactiveHeader(t, fields), payload...), false)
	_ = owner.input.Close()
	if err := owner.wait(t, 5*time.Second); err != nil {
		t.Fatalf("streaming failed: %v; stderr=%s", err, owner.stderr.Bytes())
	}
	if !bytes.Equal(owner.stdout.Bytes(), payload) || string(owner.stderr.Bytes()) != "synthetic-stderr\n" {
		t.Fatalf("direct stream changed: got=%d want=%d stderr=%q", len(owner.stdout.Bytes()), len(payload), owner.stderr.Bytes())
	}
	verifyInteractiveCleanup(t, directory, true)
}

func TestInteractiveRespondsBeforeParentEOFAndClosesChildInput(t *testing.T) {
	directory, fields := interactiveFixture(t, "dialogue", 10000)
	owner := startInteractiveOwner(t, directory, "interactive")
	owner.write(t, append(interactiveHeader(t, fields), []byte("one\n")...), false)
	owner.awaitOutput(t, "reply:one\n")
	owner.write(t, []byte("two\n"), false)
	owner.awaitOutput(t, "reply:two\n")
	_ = owner.input.Close()
	if err := owner.wait(t, 3*time.Second); err != nil {
		t.Fatalf("dialogue failed: %v; stderr=%s", err, owner.stderr.Bytes())
	}
	if string(owner.stdout.Bytes()) != "reply:one\nreply:two\nstdin-closed\n" {
		t.Fatalf("EOF or incremental delivery changed: %q", owner.stdout.Bytes())
	}
	verifyInteractiveCleanup(t, directory, true)
}

func TestInteractiveChildExitDoesNotWaitForParentEOF(t *testing.T) {
	directory, fields := interactiveFixture(t, "exit", 10000)
	owner := startInteractiveOwner(t, directory, "interactive")
	owner.write(t, interactiveHeader(t, fields), false)
	// Intentionally leave the parent's write pipe open until test cleanup.
	if err := owner.wait(t, 3*time.Second); err != nil {
		t.Fatalf("child exit failed: %v; stderr=%s", err, owner.stderr.Bytes())
	}
	if string(owner.stdout.Bytes()) != "child-exited\n" {
		t.Fatalf("child output changed: %q", owner.stdout.Bytes())
	}
	verifyInteractiveCleanup(t, directory, true)
}

func TestInteractiveInputErrorCannotBecomeSuccessfulChildExit(t *testing.T) {
	for attempt := 0; attempt < 5; attempt++ {
		t.Run(fmt.Sprintf("race-%d", attempt+1), func(t *testing.T) {
			directory, fields := interactiveFixture(t, "echo", 10000)
			owner := startInteractiveOwner(t, directory, "input-error")
			payload := []byte("delivered before the synthetic read error\n")
			owner.write(t, append(interactiveHeader(t, fields), payload...), false)
			owner.awaitOutput(t, string(payload))
			_ = owner.input.Close()
			if owner.wait(t, 3*time.Second) == nil || owner.command.ProcessState.ExitCode() != 1 {
				t.Fatalf("real input error was lost to child exit: stdout=%q stderr=%q", owner.stdout.Bytes(), owner.stderr.Bytes())
			}
			if !bytes.Contains(owner.stderr.Bytes(), []byte("interactive provider input is incomplete")) {
				t.Fatalf("missing input-error diagnostic: %q", owner.stderr.Bytes())
			}
			if !bytes.Equal(owner.stdout.Bytes(), payload) {
				t.Fatalf("delivered prefix changed: %q", owner.stdout.Bytes())
			}
			// The child may exit naturally or be stopped first. Neither outcome
			// changes the supervisor's independent incomplete-input result.
			events := readInteractiveEvents(t, directory)
			if len(events) != 4 || events[2].ExitCode == nil {
				t.Fatalf("missing child terminal evidence: %+v", events)
			}
			verifyInteractiveCleanup(t, directory, *events[2].ExitCode == 0)
		})
	}
	t.Run("child-exit-first", func(t *testing.T) {
		directory, fields := interactiveFixture(t, "exit", 10000)
		owner := startInteractiveOwner(t, directory, "input-error-after-child-exit")
		owner.write(t, interactiveHeader(t, fields), false)
		// Keep parent stdin open. The wrapper cannot deliver its non-close
		// error until the owner has selected normal child exit and closes it.
		if owner.wait(t, 3*time.Second) == nil || owner.command.ProcessState.ExitCode() != 1 {
			t.Fatalf("Wait-first path discarded its input error: stdout=%q stderr=%q", owner.stdout.Bytes(), owner.stderr.Bytes())
		}
		if !bytes.Contains(owner.stderr.Bytes(), []byte("interactive provider input is incomplete")) {
			t.Fatalf("Wait-first path omitted input-error diagnostic: %q", owner.stderr.Bytes())
		}
		if string(owner.stdout.Bytes()) != "child-exited\n" {
			t.Fatalf("normal early child output changed: %q", owner.stdout.Bytes())
		}
		// The child itself must have succeeded: only input delivery failed.
		verifyInteractiveCleanup(t, directory, true)
	})
}

func TestInteractiveRejectsRegularFileBeforeStartingChild(t *testing.T) {
	directory, fields := interactiveFixture(t, "echo", 10000)
	if err := os.WriteFile(filepath.Join(directory, "regular-input.bin"), interactiveHeader(t, fields), 0600); err != nil {
		t.Fatal(err)
	}
	owner := startInteractiveOwner(t, directory, "regular-file")
	if owner.wait(t, 3*time.Second) == nil || owner.command.ProcessState.ExitCode() != 2 {
		t.Fatalf("regular-file stdin was accepted: stdout=%q stderr=%q", owner.stdout.Bytes(), owner.stderr.Bytes())
	}
	if len(owner.stdout.Bytes()) != 0 || !bytes.Contains(owner.stderr.Bytes(), []byte("interactive stdin must be a Host-owned pipe")) {
		t.Fatalf("missing pipe-only diagnostic: stdout=%q stderr=%q", owner.stdout.Bytes(), owner.stderr.Bytes())
	}
	for _, name := range []string{"control.jsonl", "child.json", "grandchild.json"} {
		if _, err := os.Stat(filepath.Join(directory, name)); !os.IsNotExist(err) {
			t.Fatalf("regular-file stdin created %s or absence is unverified: %v", name, err)
		}
	}
}

func TestInteractiveDeadlineWithParentInputOpen(t *testing.T) {
	directory, fields := interactiveFixture(t, "wait", 1200)
	owner := startInteractiveOwner(t, directory, "interactive")
	owner.write(t, interactiveHeader(t, fields), false)
	owner.awaitOutput(t, "child-ready\n")
	if owner.wait(t, 4*time.Second) == nil {
		t.Fatal("deadline reported success")
	}
	verifyInteractiveCleanup(t, directory, false)
}

func TestInteractiveDeadlineCleansGrandchildPort(t *testing.T) {
	if !DetachedJobOwnerSupported {
		t.Skip("nested process exit verification requires the tested Windows Job Object boundary")
	}
	directory, fields := interactiveFixture(t, "nested-port", 2000)
	owner := startInteractiveOwner(t, directory, "interactive")
	owner.write(t, interactiveHeader(t, fields), false)
	var grandchild interactiveProcessRecord
	deadline := time.Now().Add(1500 * time.Millisecond)
	for grandchild.PID == 0 && time.Now().Before(deadline) {
		data, _ := os.ReadFile(filepath.Join(directory, "grandchild.json"))
		_ = json.Unmarshal(data, &grandchild)
		if grandchild.PID == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if grandchild.PID <= 0 || grandchild.Address == "" {
		t.Fatalf("nested child did not record its port; stderr=%s", owner.stderr.Bytes())
	}
	t.Logf("owned-grandchild pid=%d parent=%d command=%q cwd=%q address=%s", grandchild.PID, grandchild.ParentPID, grandchild.Command, grandchild.Directory, grandchild.Address)
	connection, err := net.DialTimeout("tcp", grandchild.Address, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("fixture port was not live before deadline: %v", err)
	}
	_ = connection.Close()
	if owner.wait(t, 4*time.Second) == nil {
		t.Fatal("nested deadline reported success")
	}
	verifyInteractiveCleanup(t, directory, false)
	for _, pid := range []int{grandchild.ParentPID, grandchild.PID} {
		if err := waitOwnedFixtureExit(pid); err != nil {
			t.Fatal(err)
		}
	}
	connection, err = net.DialTimeout("tcp", grandchild.Address, 200*time.Millisecond)
	if err == nil {
		_ = connection.Close()
		t.Fatal("owned grandchild port survived deadline cleanup")
	}
	t.Logf("owned-tree-exited owner=%d child=%d grandchild=%d portReleased=true", owner.command.Process.Pid, grandchild.ParentPID, grandchild.PID)
}

func TestInteractiveExtensionLeavesOneShotUnchanged(t *testing.T) {
	directory, fields := interactiveFixture(t, "echo", 10000)
	delete(fields, "interactiveProtocolVersion")
	delete(fields, "timeoutMs")
	payload := []byte("one-shot bounded input\n\x00")
	fields["inputBase64"] = base64.StdEncoding.EncodeToString(payload)
	owner := startInteractiveOwner(t, directory, "oneshot")
	owner.write(t, interactiveHeader(t, fields), false)
	_ = owner.input.Close()
	if err := owner.wait(t, 3*time.Second); err != nil {
		t.Fatalf("existing one-shot failed: %v; stderr=%s", err, owner.stderr.Bytes())
	}
	if !bytes.Equal(owner.stdout.Bytes(), payload) || !strings.Contains(string(owner.stderr.Bytes()), "synthetic-stderr") {
		t.Fatal("existing one-shot payload/output changed")
	}
	verifyInteractiveCleanup(t, directory, true)
}
