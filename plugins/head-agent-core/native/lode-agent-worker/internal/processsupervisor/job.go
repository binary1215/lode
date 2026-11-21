package processsupervisor

// The bounded job owner is Host-local operational state, never HEAD recovery
// direction. It does not create or consume a Core authorization by itself.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const JobProtocolVersion = "0.1.0"

type JobRequest struct {
	ProtocolVersion string  `json:"protocolVersion"`
	Request         Request `json:"request"`
	TimeoutMS       int     `json:"timeoutMs"`
	DeadlineUnixMS  int64   `json:"deadlineUnixMs"`
	MaxStdoutBytes  int64   `json:"maxStdoutBytes"`
	MaxStderrBytes  int64   `json:"maxStderrBytes"`
}

type jobTerminal struct {
	ProtocolVersion   string `json:"protocolVersion"`
	RequestDigest     string `json:"requestDigest"`
	ExitCode          int    `json:"exitCode"`
	Reason            string `json:"reason"`
	CompleteOutput    bool   `json:"completeOutput"`
	OwnerExitRequired bool   `json:"ownerExitRequired"`
	StdoutBytes       int64  `json:"stdoutBytes"`
	StderrBytes       int64  `json:"stderrBytes"`
	StdoutDigest      string `json:"stdoutDigest"`
	StderrDigest      string `json:"stderrDigest"`
	ControlBytes      int64  `json:"controlBytes"`
	ControlDigest     string `json:"controlDigest"`
}

type boundedSpool struct {
	file     *os.File
	limit    int64
	written  int64
	overflow bool
	stop     chan<- string
	hash     hash.Hash
}

func (w *boundedSpool) Write(data []byte) (int, error) {
	length := len(data)
	remaining := w.limit - w.written
	if int64(length) > remaining {
		w.overflow = true
		select {
		case w.stop <- "output-limit":
		default:
		}
		data = data[:remaining]
	}
	n, err := w.file.Write(data)
	w.written += int64(n)
	_, _ = w.hash.Write(data[:n])
	if err != nil {
		select {
		case w.stop <- "spool-error":
		default:
		}
		return n, err
	}
	if err := w.file.Sync(); err != nil {
		return n, err
	}
	// Drain beyond the bound until the owner terminates the exact tree. Never
	// allocate or retain the discarded tail in the frontend.
	return length, nil
}

func writeJobRecord(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	staging := file + ".pending"
	f, err := os.OpenFile(staging, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(append(data, '\n'))
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	// Hard-link publication is create-only on both Windows and POSIX.
	if err := os.Link(staging, file); err != nil {
		return err
	}
	return os.Remove(staging)
}

// RunJob owns deadline, bounded output and terminal publication independently
// of frontend stdio. The Host must separately establish detached OS lifetime,
// protect this directory from children, and reconcile owner exit/lease evidence.
func RunJob(requestFile string) (int, error) {
	job, input, data, resolved, err := readJobRequest(requestFile)
	if err != nil {
		return 2, err
	}
	if expected := os.Getenv("HEAD_NATIVE_JOB_REQUEST_DIGEST"); expected != "" {
		observed := sha256.Sum256(data)
		if expected != hex.EncodeToString(observed[:]) {
			return 2, errors.New("job request changed after launch intent")
		}
	}
	directory := filepath.Dir(resolved)
	return runPreparedJob(job, input, data, directory)
}

func readJobRequest(requestFile string) (JobRequest, []byte, []byte, string, error) {
	invalid := func(err error) (JobRequest, []byte, []byte, string, error) {
		return JobRequest{}, nil, nil, "", err
	}
	resolved, err := canonicalJobRequestPath(requestFile)
	if err != nil {
		return invalid(err)
	}
	f, err := os.Open(requestFile)
	if err != nil {
		return invalid(err)
	}
	data, readErr := io.ReadAll(io.LimitReader(f, maxRequestBytes+1))
	_ = f.Close()
	if readErr != nil || len(data) > maxRequestBytes {
		return invalid(errors.New("job request exceeds bound"))
	}
	var job JobRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&job); err != nil {
		return invalid(err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return invalid(errors.New("job request has trailing data"))
	}
	if job.ProtocolVersion != JobProtocolVersion || job.TimeoutMS < 100 || job.TimeoutMS > 600000 ||
		job.DeadlineUnixMS <= 0 || job.DeadlineUnixMS > time.Now().UnixMilli()+int64(job.TimeoutMS)+1000 ||
		job.MaxStdoutBytes < 1 || job.MaxStdoutBytes > 64*1024*1024 || job.MaxStderrBytes < 1 || job.MaxStderrBytes > 4*1024*1024 {
		return invalid(errors.New("job limits or protocol are invalid"))
	}
	input, err := validateRequest(job.Request)
	if err != nil {
		return invalid(err)
	}
	directory := filepath.Dir(resolved)
	if job.Request.ControlFile != filepath.Join(directory, "control.jsonl") {
		return invalid(errors.New("job control file must be in the owned directory"))
	}
	return job, input, data, resolved, nil
}

func runPreparedJob(job JobRequest, input, data []byte, directory string) (int, error) {
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	claimFile := filepath.Join(directory, "claim.json")
	ownerToken := ownProcessToken()
	if DetachedJobOwnerSupported && ownerToken == "" {
		return 2, errors.New("owner process creation identity is unavailable")
	}
	if err := writeJobRecord(claimFile, map[string]any{"requestDigest": digest, "pid": os.Getpid(), "ownerToken": ownerToken, "startedAt": time.Now().UTC()}); err != nil {
		return 2, fmt.Errorf("job already claimed or publication uncertain; reconcile without relaunch: %w", err)
	}
	out, err := os.OpenFile(filepath.Join(directory, "stdout.bin"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return 2, err
	}
	defer out.Close()
	errout, err := os.OpenFile(filepath.Join(directory, "stderr.bin"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return 2, err
	}
	defer errout.Close()
	stop := make(chan string, 1)
	stdout := &boundedSpool{file: out, limit: job.MaxStdoutBytes, stop: stop, hash: sha256.New()}
	stderr := &boundedSpool{file: errout, limit: job.MaxStderrBytes, stop: stop, hash: sha256.New()}
	done := make(chan struct{})
	var watcher sync.WaitGroup
	watcher.Add(1)
	go func() {
		defer watcher.Done()
		timer := time.NewTimer(time.Until(time.UnixMilli(job.DeadlineUnixMS)))
		defer timer.Stop()
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-timer.C:
				select {
				case stop <- "timeout":
				default:
				}
				return
			case <-ticker.C:
				// Existence is a local control request, not user direction. The Host
				// protects this inbox; no arbitrary path or PID is accepted here.
				if _, err := os.Lstat(filepath.Join(directory, "cancel")); err == nil {
					select {
					case stop <- "cancel":
					default:
					}
					return
				}
			}
		}
	}()
	reason := "exited"
	exitCode := 143
	var runErr error
	if _, cancelErr := os.Lstat(filepath.Join(directory, "cancel")); cancelErr == nil {
		reason = "cancel"
	} else if !os.IsNotExist(cancelErr) {
		runErr = cancelErr
	} else if time.Now().UnixMilli() >= job.DeadlineUnixMS {
		reason = "timeout"
	} else {
		exitCode, runErr = runRequest(job.Request, input, stdout, stderr, stop, func(value string) { reason = value })
	}
	close(done)
	watcher.Wait()
	if runErr != nil {
		reason = "owner-error"
	}
	if stdout.overflow || stderr.overflow {
		reason = "output-limit"
	}
	if err := out.Sync(); err != nil {
		return 2, err
	}
	if err := errout.Sync(); err != nil {
		return 2, err
	}
	var control []byte
	controlFile, controlErr := os.Open(job.Request.ControlFile)
	if controlErr == nil {
		control, controlErr = io.ReadAll(io.LimitReader(controlFile, 64*1024+1))
		_ = controlFile.Close()
	}
	if controlErr != nil && !os.IsNotExist(controlErr) || len(control) > 64*1024 {
		return 2, errors.New("job cleanup evidence is unreadable or exceeds its bound")
	}
	controlHash := sha256.Sum256(control)
	terminal := jobTerminal{ProtocolVersion: JobProtocolVersion, RequestDigest: digest, ExitCode: exitCode,
		Reason: reason, CompleteOutput: reason == "exited" && runErr == nil && !stdout.overflow && !stderr.overflow,
		OwnerExitRequired: true, StdoutBytes: stdout.written, StderrBytes: stderr.written,
		StdoutDigest: hex.EncodeToString(stdout.hash.Sum(nil)), StderrDigest: hex.EncodeToString(stderr.hash.Sum(nil)),
		ControlBytes: int64(len(control)), ControlDigest: hex.EncodeToString(controlHash[:])}
	if err := writeJobRecord(filepath.Join(directory, "terminal.json"), terminal); err != nil {
		return 2, err
	}
	return exitCode, runErr
}
