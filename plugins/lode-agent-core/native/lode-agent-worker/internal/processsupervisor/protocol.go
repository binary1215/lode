package processsupervisor

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const ProtocolVersion = "0.1.0"
const InteractiveProtocolVersion = "0.1.0"

const (
	maxRequestBytes = 8 * 1024 * 1024
	maxInputBytes   = 4 * 1024 * 1024
)

type Request struct {
	SchemaVersion      int               `json:"schemaVersion"`
	ProtocolVersion    string            `json:"protocolVersion"`
	Executable         string            `json:"executable"`
	Arguments          []string          `json:"arguments"`
	WorkingDirectory   string            `json:"workingDirectory"`
	Environment        map[string]string `json:"environment"`
	InputBase64        string            `json:"inputBase64"`
	ControlFile        string            `json:"controlFile"`
	TerminationGraceMS int               `json:"terminationGraceMs"`
}

type interactiveRequest struct {
	Request
	InteractiveProtocolVersion string `json:"interactiveProtocolVersion"`
	TimeoutMS                  int    `json:"timeoutMs"`
}

type controlEvent struct {
	Type                     string `json:"type"`
	ProtocolVersion          string `json:"protocolVersion"`
	Strategy                 string `json:"strategy,omitempty"`
	TreeOwnershipEstablished bool   `json:"treeOwnershipEstablished"`
	ProviderPID              int    `json:"providerPid,omitempty"`
	ExitCode                 *int   `json:"exitCode,omitempty"`
	CleanupAttempted         bool   `json:"cleanupAttempted"`
	CleanupVerified          bool   `json:"cleanupVerified"`
	ForceUsed                bool   `json:"forceUsed"`
	KernelCleanupOnExit      bool   `json:"kernelCleanupOnExit"`
}

type cleanupResult struct {
	Attempted           bool
	Verified            bool
	ForceUsed           bool
	KernelCleanupOnExit bool
}

type platformController interface {
	Strategy() string
	Configure(*exec.Cmd)
	Terminate(pid int, force bool) error
	CleanupAfterProviderExit(pid int, grace time.Duration) cleanupResult
}

type eventWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
	sync    func() error
}

func (writer *eventWriter) emit(event controlEvent) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	event.ProtocolVersion = ProtocolVersion
	if err := writer.encoder.Encode(event); err != nil {
		return err
	}
	if writer.sync != nil {
		return writer.sync()
	}
	return nil
}

func validateRequest(request Request) ([]byte, error) {
	if request.SchemaVersion != 1 || request.ProtocolVersion != ProtocolVersion {
		return nil, errors.New("supervisor request protocol is incompatible")
	}
	if !filepath.IsAbs(request.Executable) || strings.ContainsRune(request.Executable, '\x00') {
		return nil, errors.New("supervisor executable must be an absolute path")
	}
	stat, err := os.Stat(request.Executable)
	if err != nil || stat.IsDir() {
		return nil, errors.New("supervisor executable is not a regular file")
	}
	if !filepath.IsAbs(request.WorkingDirectory) || strings.ContainsRune(request.WorkingDirectory, '\x00') {
		return nil, errors.New("supervisor working directory must be absolute")
	}
	if stat, err := os.Stat(request.WorkingDirectory); err != nil || !stat.IsDir() {
		return nil, errors.New("supervisor working directory is unavailable")
	}
	if len(request.Arguments) > 256 || len(request.Environment) > 256 {
		return nil, errors.New("supervisor argument or environment count exceeds its bound")
	}
	for _, argument := range request.Arguments {
		if strings.ContainsRune(argument, '\x00') || len(argument) > 64*1024 {
			return nil, errors.New("supervisor argument is invalid")
		}
	}
	for key, value := range request.Environment {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') || len(key)+len(value) > 64*1024 {
			return nil, errors.New("supervisor environment is invalid")
		}
	}
	if request.TerminationGraceMS < 100 || request.TerminationGraceMS > 10_000 {
		return nil, errors.New("supervisor termination grace is outside its bound")
	}
	if !filepath.IsAbs(request.ControlFile) || strings.ContainsRune(request.ControlFile, '\x00') {
		return nil, errors.New("supervisor control file must be an absolute path")
	}
	input, err := base64.StdEncoding.DecodeString(request.InputBase64)
	if err != nil || len(input) > maxInputBytes {
		return nil, errors.New("supervisor input is invalid or exceeds its bound")
	}
	return input, nil
}

func readRequest(reader io.Reader) (Request, []byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
	if err != nil || len(data) > maxRequestBytes {
		return Request{}, nil, errors.New("supervisor request exceeds its bound")
	}
	var request Request
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return Request{}, nil, fmt.Errorf("supervisor request is invalid: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Request{}, nil, errors.New("supervisor request contains trailing data")
	}
	input, err := validateRequest(request)
	return request, input, err
}

func environmentList(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+environment[key])
	}
	return result
}

func processExitCode(state *os.ProcessState, waitError error) int {
	if state != nil && state.ExitCode() >= 0 {
		return state.ExitCode()
	}
	if waitError == nil {
		return 0
	}
	return 1
}

func Run(reader io.Reader, stdout io.Writer, stderr io.Writer) (int, error) {
	request, input, err := readRequest(reader)
	if err != nil {
		return 2, err
	}
	return runRequest(request, input, stdout, stderr, nil, nil)
}

func runRequest(request Request, input []byte, stdout io.Writer, stderr io.Writer, stop <-chan string, onStop func(string)) (int, error) {
	return runRequestInput(request, bytes.NewReader(input), nil, stdout, stderr, stop, onStop)
}

// RunInteractive owns reader until the exact direct provider exits. Closing
// reader must unblock a pending Read (Host-piped os.Stdin/io.PipeReader do this).
// Console/file stdin is not accepted as a streaming Host transport. The
// bootstrap is one bounded line, not part of provider stdin; already-buffered
// following bytes remain in the very same reader. Total stream/output budgets
// belong to the authorized Host; this owner bounds buffering and post-bootstrap
// lifetime. The Host must enforce its own bootstrap/deadline watchdog as well.
func RunInteractive(reader io.ReadCloser, stdout io.Writer, stderr io.Writer) (int, error) {
	if file, ok := reader.(*os.File); ok {
		defer file.Close()
		prepared, err := prepareInteractivePipe(file)
		if err != nil {
			return 2, fmt.Errorf("interactive stdin must be a Host-owned pipe or anonymous local stream: %w", err)
		}
		reader = prepared
	}
	defer reader.Close()
	buffered := bufio.NewReaderSize(reader, 64*1024)
	header := make([]byte, 0, 64*1024)
	for {
		fragment, err := buffered.ReadSlice('\n')
		if len(header)+len(fragment) > maxRequestBytes {
			return 2, errors.New("interactive bootstrap exceeds its bound")
		}
		header = append(header, fragment...)
		if err == nil {
			break
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return 2, errors.New("interactive bootstrap requires one complete newline-terminated frame")
		}
	}
	request, err := decodeInteractiveRequest(header)
	if err != nil {
		return 2, err
	}
	stop := make(chan string, 1)
	timer := time.AfterFunc(time.Duration(request.TimeoutMS)*time.Millisecond, func() { stop <- "timeout" })
	defer timer.Stop()
	return runRequestInput(request.Request, buffered, reader, stdout, stderr, stop, nil)
}

func decodeInteractiveRequest(data []byte) (interactiveRequest, error) {
	invalid := errors.New("interactive bootstrap is invalid")
	if !utf8.Valid(data) || uniqueInteractiveJSON(data) != nil {
		return interactiveRequest{}, invalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) != 11 {
		return interactiveRequest{}, invalid
	}
	for _, key := range []string{"schemaVersion", "protocolVersion", "executable", "arguments", "workingDirectory", "environment", "inputBase64", "controlFile", "terminationGraceMs", "interactiveProtocolVersion", "timeoutMs"} {
		if _, exists := fields[key]; !exists {
			return interactiveRequest{}, invalid
		}
	}
	var request interactiveRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		request.InteractiveProtocolVersion != InteractiveProtocolVersion || request.InputBase64 != "" ||
		request.TimeoutMS < 100 || request.TimeoutMS > 3_600_000 {
		return interactiveRequest{}, invalid
	}
	if _, err := validateRequest(request.Request); err != nil {
		return interactiveRequest{}, err
	}
	return request, nil
}

// Unlike a free-form provider frame, bootstrap names and null/duplicate values
// cannot be ambiguous. This strict path does not change one-shot decoding.
func uniqueInteractiveJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var readValue func(int) error
	readValue = func(depth int) error {
		if depth > 16 {
			return errors.New("interactive bootstrap is too deep")
		}
		token, err := decoder.Token()
		if err != nil || token == nil {
			return errors.New("interactive bootstrap contains an invalid value")
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				seen := map[string]bool{}
				for decoder.More() {
					key, err := decoder.Token()
					name, ok := key.(string)
					if err != nil || !ok || seen[name] {
						return errors.New("interactive bootstrap contains duplicate names")
					}
					seen[name] = true
					if err := readValue(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for decoder.More() {
					if err := readValue(depth + 1); err != nil {
						return err
					}
				}
			default:
				return errors.New("interactive bootstrap contains an unexpected delimiter")
			}
			_, err = decoder.Token()
		}
		return err
	}
	if err := readValue(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("interactive bootstrap contains trailing values")
	}
	return nil
}

func runRequestInput(request Request, input io.Reader, interactiveInput io.Closer, stdout io.Writer, stderr io.Writer, stop <-chan string, onStop func(string)) (int, error) {
	controlFile, err := os.OpenFile(request.ControlFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 2, fmt.Errorf("supervisor control file could not be created: %w", err)
	}
	defer controlFile.Close()
	controller, err := newPlatformController()
	if err != nil {
		return 2, fmt.Errorf("process-tree ownership could not be established: %w", err)
	}
	events := &eventWriter{encoder: json.NewEncoder(controlFile), sync: controlFile.Sync}
	if err := events.emit(controlEvent{
		Type:                     "supervisor.ready",
		Strategy:                 controller.Strategy(),
		TreeOwnershipEstablished: true,
	}); err != nil {
		return 2, errors.New("supervisor control channel rejected readiness evidence")
	}

	command := exec.Command(request.Executable, request.Arguments...)
	command.Dir = request.WorkingDirectory
	command.Env = environmentList(request.Environment)
	var inputPipe io.WriteCloser
	var inputDone chan error
	var inputFailed chan string
	inputClosing := make(chan struct{})
	var inputCloseOnce sync.Once
	closeInteractiveInput := func() {
		if interactiveInput != nil {
			inputCloseOnce.Do(func() {
				close(inputClosing)
				_ = interactiveInput.Close()
				_ = inputPipe.Close()
			})
		}
	}
	if interactiveInput == nil {
		command.Stdin = input
	} else {
		inputPipe, err = command.StdinPipe()
		if err != nil {
			return 2, errors.New("interactive provider stdin could not be prepared")
		}
		defer inputPipe.Close()
		inputDone = make(chan error, 1)
		inputFailed = make(chan string, 1)
	}
	command.Stdout = stdout
	command.Stderr = stderr
	// A descendant may inherit stdout/stderr after the direct provider exits.
	// Do not wait forever for EOF before the native owner can exit and trigger
	// its kernel tree cleanup boundary.
	command.WaitDelay = time.Duration(request.TerminationGraceMS) * time.Millisecond
	controller.Configure(command)
	if err := command.Start(); err != nil {
		return 2, fmt.Errorf("provider process could not start: %w", err)
	}
	providerPID := command.Process.Pid
	if err := events.emit(controlEvent{
		Type:                     "provider.started",
		Strategy:                 controller.Strategy(),
		TreeOwnershipEstablished: true,
		ProviderPID:              providerPID,
	}); err != nil {
		closeInteractiveInput()
		_ = controller.Terminate(providerPID, true)
		_ = command.Wait()
		return 2, errors.New("supervisor control channel rejected provider ownership evidence")
	}
	if interactiveInput != nil {
		go func() {
			_, copyErr := io.Copy(inputPipe, input)
			select {
			case <-inputClosing:
				// Only a known Close-unblock error caused by our shutdown is
				// ignorable. Preserve every other delivery error even when the
				// provider Wait and inputFailed channels become ready together.
				if errors.Is(copyErr, os.ErrClosed) || errors.Is(copyErr, io.ErrClosedPipe) {
					copyErr = nil
				}
			default:
			}
			_ = inputPipe.Close() // Parent EOF is graceful provider stdin EOF.
			inputDone <- copyErr
			if copyErr != nil {
				inputFailed <- "input-error"
			}
		}()
	}

	waitChannel := make(chan error, 1)
	go func() { waitChannel <- command.Wait() }()
	signalChannel := make(chan os.Signal, 1)
	signal.Notify(signalChannel, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signalChannel)
	terminationRequested := false
	forceUsed := false
	var waitError error
	var requestedReason string
	select {
	case waitError = <-waitChannel:
	case <-signalChannel:
		requestedReason = "signal"
	case requestedReason = <-stop:
	case requestedReason = <-inputFailed:
	}
	if requestedReason != "" {
		if onStop != nil {
			onStop(requestedReason)
		}
		terminationRequested = true
		closeInteractiveInput()
		_ = controller.Terminate(providerPID, false)
		select {
		case waitError = <-waitChannel:
		case <-time.After(time.Duration(request.TerminationGraceMS) * time.Millisecond):
			forceUsed = true
			_ = controller.Terminate(providerPID, true)
			waitError = <-waitChannel
		}
	}
	inputIncomplete := false
	if interactiveInput != nil {
		closeInteractiveInput()
		select {
		case inputErr := <-inputDone:
			inputIncomplete = inputErr != nil
		case <-time.After(time.Duration(request.TerminationGraceMS) * time.Millisecond):
			inputIncomplete = true
		}
	}

	exitCode := processExitCode(command.ProcessState, waitError)
	if terminationRequested && exitCode == 0 {
		exitCode = 143
	}
	_ = events.emit(controlEvent{Type: "provider.exited", ProviderPID: providerPID, ExitCode: &exitCode})
	cleanup := controller.CleanupAfterProviderExit(providerPID, time.Duration(request.TerminationGraceMS)*time.Millisecond)
	cleanup.ForceUsed = cleanup.ForceUsed || forceUsed
	if err := events.emit(controlEvent{
		Type:                "supervisor.cleanup",
		Strategy:            controller.Strategy(),
		CleanupAttempted:    cleanup.Attempted,
		CleanupVerified:     cleanup.Verified,
		ForceUsed:           cleanup.ForceUsed,
		KernelCleanupOnExit: cleanup.KernelCleanupOnExit,
	}); err != nil {
		return 2, errors.New("supervisor control channel rejected cleanup evidence")
	}
	if errors.Is(waitError, exec.ErrWaitDelay) {
		return 1, errors.New("provider output remained open after exit; output is incomplete")
	}
	if inputIncomplete || requestedReason == "input-error" {
		return 1, errors.New("interactive provider input is incomplete")
	}
	return exitCode, nil
}
