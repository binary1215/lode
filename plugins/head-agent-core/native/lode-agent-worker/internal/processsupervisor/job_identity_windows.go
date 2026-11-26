//go:build windows

package processsupervisor

import (
	"fmt"
	"os"
	"syscall"
)

func observeOwnerProcess(pid int) (string, string) {
	if pid < 1 || uint64(pid) > 0xffffffff {
		return "", "unknown"
	}
	// Query and wait only; this handle has no termination or write permission.
	handle, err := syscall.OpenProcess(0x1000|0x00100000, false, uint32(pid))
	if err == syscall.Errno(87) {
		return "", "gone"
	}
	if err != nil {
		return "", "unknown"
	}
	defer syscall.CloseHandle(handle)
	var created, exited, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(handle, &created, &exited, &kernel, &user) != nil {
		return "", "unknown"
	}
	token := fmt.Sprintf("windows-filetime-%08x%08x", created.HighDateTime, created.LowDateTime)
	state, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil {
		return token, "unknown"
	}
	if state == 0 {
		return token, "gone"
	}
	if state == 258 {
		return token, "present"
	}
	return token, "unknown"
}

func ownProcessToken() string { token, _ := observeOwnerProcess(os.Getpid()); return token }
