//go:build !windows

package processsupervisor

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestInteractiveInheritedPipeCloseUnblocksWithoutParentEOF(t *testing.T) {
	// syscall.Pipe produces blocking inherited-style descriptors, unlike os.Pipe.
	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	source := os.NewFile(uintptr(fds[0]), "synthetic-inherited-reader")
	writer := os.NewFile(uintptr(fds[1]), "synthetic-parent-writer")
	t.Cleanup(func() { _ = source.Close(); _ = writer.Close() })
	if err := source.SetReadDeadline(time.Time{}); !errors.Is(err, os.ErrNoDeadline) {
		t.Fatalf("fixture must start as a nonpollable inherited pipe: %v", err)
	}
	reader, err := prepareInteractivePipe(source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	if reader == source {
		t.Fatal("must own a separate pollable descriptor")
	}
	assertInteractiveCloseOnExec(t, reader)
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		_, err := io.Copy(io.Discard, reader)
		done <- err
	}()
	<-started
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("owned close must surface the existing recognized close error: %v", err)
		}
	case <-time.After(time.Second):
		_ = writer.Close() // Release the exact test-owned read even on failure.
		<-done
		t.Fatal("closing owned input waited for parent EOF")
	}
}

func assertInteractiveCloseOnExec(t *testing.T, reader *os.File) {
	t.Helper()
	raw, err := reader.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var flags uintptr
	var errno syscall.Errno
	if err := raw.Control(func(fd uintptr) {
		flags, _, errno = syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
	}); err != nil || errno != 0 || flags&syscall.FD_CLOEXEC == 0 {
		t.Fatalf("owned descriptor could leak into provider exec: flags=%d errno=%v err=%v", flags, errno, err)
	}
}

func interactiveSocketPair(t *testing.T, kind int) (*os.File, *os.File) {
	t.Helper()
	// syscall.Socketpair does not add CLOEXEC. Inheriting the Host writer in
	// the owner/provider would keep stdin open after the parent closes it.
	syscall.ForkLock.RLock()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, kind, 0)
	if err == nil {
		syscall.CloseOnExec(fds[0])
		syscall.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	source := os.NewFile(uintptr(fds[0]), "synthetic-stdio-socket")
	writer := os.NewFile(uintptr(fds[1]), "synthetic-host-socket")
	t.Cleanup(func() { _ = source.Close(); _ = writer.Close() })
	assertInteractiveCloseOnExec(t, source)
	assertInteractiveCloseOnExec(t, writer)
	return source, writer
}

func TestInteractiveAnonymousStreamCloseAndCloexec(t *testing.T) {
	source, writer := interactiveSocketPair(t, syscall.SOCK_STREAM)
	reader, err := prepareInteractivePipe(source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	assertInteractiveCloseOnExec(t, reader)
	// Confirm a pending socket read is pollable before testing owner close.
	if err := reader.SetReadDeadline(time.Now().Add(10 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("socket read did not honor its deadline: %v", err)
	}
	_ = reader.SetReadDeadline(time.Time{})
	done := make(chan error, 1)
	go func() { _, err := reader.Read(make([]byte, 1)); done <- err }()
	_ = reader.Close()
	select {
	case err := <-done:
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("socket close did not unblock with a close error: %v", err)
		}
	case <-time.After(time.Second):
		_ = writer.Close()
		<-done
		t.Fatal("socket close did not unblock read")
	}
}

func TestInteractiveAnonymousStreamRoundTripAndEarlyChildExit(t *testing.T) {
	for _, mode := range []string{"dialogue", "exit"} {
		t.Run(mode, func(t *testing.T) {
			directory, fields := interactiveFixture(t, mode, 10000)
			source, writer := interactiveSocketPair(t, syscall.SOCK_STREAM)
			owner := startInteractiveOwnerInput(t, directory, "interactive", source, writer)
			owner.write(t, interactiveHeader(t, fields), false)
			if mode == "dialogue" {
				owner.write(t, []byte("one\n"), false)
				owner.awaitOutput(t, "reply:one\n")
				owner.write(t, []byte("two\n"), false)
				owner.awaitOutput(t, "reply:two\n")
				_ = owner.input.Close()
			}
			if err := owner.wait(t, 3*time.Second); err != nil {
				t.Fatalf("anonymous stdin failed: %v; stderr=%s", err, owner.stderr.Bytes())
			}
			expected := "child-exited\n"
			if mode == "dialogue" {
				expected = "reply:one\nreply:two\nstdin-closed\n"
			}
			if string(owner.stdout.Bytes()) != expected {
				t.Fatalf("socket delivery changed: %q", owner.stdout.Bytes())
			}
			verifyInteractiveCleanup(t, directory, true)
		})
	}
}

func TestInteractiveRejectsOtherSocketsBeforeBootstrap(t *testing.T) {
	for _, kind := range []string{"datagram", "network", "named"} {
		t.Run(kind, func(t *testing.T) {
			var source *os.File
			if kind == "datagram" {
				source, _ = interactiveSocketPair(t, syscall.SOCK_DGRAM)
			} else {
				domain := syscall.AF_INET
				if kind == "named" {
					domain = syscall.AF_UNIX
				}
				fd, err := syscall.Socket(domain, syscall.SOCK_STREAM, 0)
				if err != nil {
					t.Fatal(err)
				}
				source = os.NewFile(uintptr(fd), "synthetic-rejected-socket")
				t.Cleanup(func() { _ = source.Close() })
				if kind == "named" {
					// Keep below Darwin's sockaddr_un bound regardless of test name.
					dir, err := os.MkdirTemp("", "head-stdin-")
					if err != nil {
						t.Fatal(err)
					}
					name := filepath.Join(dir, "s")
					t.Cleanup(func() { _ = os.Remove(name); _ = os.Remove(dir) })
					if err := syscall.Bind(fd, &syscall.SockaddrUnix{Name: name}); err != nil {
						t.Fatal(err)
					}
				}
			}
			var stdout, stderr bytes.Buffer
			code, err := RunInteractive(source, &stdout, &stderr)
			if code != 2 || err == nil || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("unsafe stdin reached bootstrap: code=%d error=%v", code, err)
			}
			if _, err := source.Stat(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("rejected owned input leaked: %v", err)
			}
		})
	}
}

func TestInteractivePipePreparationRejectsClosedDescriptor(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	_ = reader.Close()
	if prepared, err := prepareInteractivePipe(reader); err == nil || prepared != nil {
		t.Fatalf("invalid input unexpectedly prepared: %v, %v", prepared, err)
	}
}
