//go:build !windows

package processsupervisor

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Inherited blocking stdin is not registered with Go's poller on Unix. Closing
// that File cannot reliably interrupt its blocked Read. Own a duplicate in
// nonblocking mode before NewFile so Close wakes the poller, without waiting
// for the parent writer to send EOF. The caller retains and closes the original.
// Node/libuv may use an anonymous Unix stream socketpair for piped stdio.
// Named sockets, network sockets, datagrams and ordinary files are not stdin
// transports. Ownership still comes from RunInteractive's caller, not the fd.
func prepareInteractivePipe(source *os.File) (*os.File, error) {
	stat, err := source.Stat()
	if err != nil {
		return nil, err
	}
	if stat.Mode()&os.ModeNamedPipe == 0 {
		if stat.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("not a pipe or local stream")
		}
		fd := int(source.Fd())
		kind, err := syscall.GetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_TYPE)
		if err != nil || kind != syscall.SOCK_STREAM {
			return nil, errors.New("not a stream socket")
		}
		if !isAnonymousInteractiveSocket(fd) {
			return nil, errors.New("not a connected anonymous Unix stream")
		}
	}
	// Keep the duplicate from leaking across a concurrent fork/exec.
	syscall.ForkLock.RLock()
	fd, err := syscall.Dup(int(source.Fd()))
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, err
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		return nil, err
	}
	reader := os.NewFile(uintptr(fd), source.Name())
	// A failed poller registration must be detected before provider launch.
	if err := reader.SetReadDeadline(time.Time{}); err != nil {
		_ = reader.Close()
		return nil, err
	}
	return reader, nil
}
