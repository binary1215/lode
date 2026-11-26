//go:build windows

package processsupervisor

import (
	"fmt"
	"syscall"
)

func waitOwnedFixtureExit(pid int) error {
	handle, err := syscall.OpenProcess(0x00100000, false, uint32(pid))
	if err == syscall.Errno(87) {
		return nil
	} // already absent
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	state, err := syscall.WaitForSingleObject(handle, 5000)
	if err != nil {
		return err
	}
	if state != 0 {
		return fmt.Errorf("owned fixture PID %d did not exit", pid)
	}
	return nil
}
