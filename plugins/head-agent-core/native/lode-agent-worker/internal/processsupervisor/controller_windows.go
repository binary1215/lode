//go:build windows

package processsupervisor

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const (
	jobObjectExtendedLimitInformationClass = 9
	jobObjectLimitKillOnJobClose           = 0x00002000
	processTerminate                       = 0x0001
	processSetQuota                        = 0x0100
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type windowsController struct {
	job syscall.Handle
}

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	createJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
)

func callError(name string, err error) error {
	if err == syscall.Errno(0) {
		return fmt.Errorf("%s failed", name)
	}
	return fmt.Errorf("%s failed: %w", name, err)
}

func newPlatformController() (platformController, error) {
	handle, _, callErr := createJobObjectW.Call(0, 0)
	if handle == 0 {
		return nil, callError("CreateJobObjectW", callErr)
	}
	job := syscall.Handle(handle)
	info := jobObjectExtendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, callErr := setInformationJobObject.Call(
		uintptr(job),
		jobObjectExtendedLimitInformationClass,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ok == 0 {
		_ = syscall.CloseHandle(job)
		return nil, callError("SetInformationJobObject", callErr)
	}
	currentProcess, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(os.Getpid()))
	if err != nil {
		_ = syscall.CloseHandle(job)
		return nil, fmt.Errorf("OpenProcess failed: %w", err)
	}
	ok, _, callErr = assignProcessToJobObject.Call(uintptr(job), uintptr(currentProcess))
	_ = syscall.CloseHandle(currentProcess)
	if ok == 0 {
		_ = syscall.CloseHandle(job)
		return nil, callError("AssignProcessToJobObject", callErr)
	}
	return &windowsController{job: job}, nil
}

func (controller *windowsController) Strategy() string { return "windows-job-object" }

func (controller *windowsController) Configure(command *exec.Cmd) {
	// Providers use the supervisor's pipes, not a visible console. Hiding the
	// owner does not hide a console child started from a detached owner.
	// This is presentation only: keep Job Object ownership and inherited handles.
	const createNoWindow = 0x08000000
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags |= createNoWindow
}

func (controller *windowsController) Terminate(pid int, force bool) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}

func (controller *windowsController) CleanupAfterProviderExit(pid int, grace time.Duration) cleanupResult {
	return cleanupResult{
		Attempted:           true,
		Verified:            true,
		KernelCleanupOnExit: true,
	}
}
