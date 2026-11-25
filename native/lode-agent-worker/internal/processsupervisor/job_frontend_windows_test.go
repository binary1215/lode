//go:build windows

package processsupervisor

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// The shipped launcher (`--launch-job`) is always started by the Node CLI or
// MCP server with child_process.spawn, which places it in libuv's job object:
// breakaway allowed, killed when the frontend closes. A test binary started by
// `go test` inherits the caller's job instead (on GitHub's Windows runner and
// in a desktop agent shell that job allows no breakaway), so the launcher
// helper recreates the product's frontend job before it launches. Silent
// breakaway is left off, so only the owner's explicit CREATE_BREAKAWAY_FROM_JOB
// lets it outlive this kill-on-close job when the launcher exits.
func enterFrontendJob() error {
	const jobObjectLimitBreakawayOk = 0x00000800
	handle, _, callErr := createJobObjectW.Call(0, 0)
	if handle == 0 {
		return callError("CreateJobObjectW", callErr)
	}
	info := jobObjectExtendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitBreakawayOk | jobObjectLimitKillOnJobClose
	ok, _, callErr := setInformationJobObject.Call(handle, jobObjectExtendedLimitInformationClass, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if ok == 0 {
		return callError("SetInformationJobObject", callErr)
	}
	current, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(os.Getpid()))
	if err != nil {
		return fmt.Errorf("OpenProcess failed: %w", err)
	}
	defer syscall.CloseHandle(current)
	if ok, _, callErr = assignProcessToJobObject.Call(handle, uintptr(current)); ok == 0 {
		return callError("AssignProcessToJobObject", callErr)
	}
	// The job handle stays open until this launcher process exits, like the
	// frontend's: its exit then kills whatever did not break away.
	return nil
}
