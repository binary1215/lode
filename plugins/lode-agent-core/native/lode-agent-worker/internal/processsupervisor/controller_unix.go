//go:build !windows

package processsupervisor

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

type unixController struct{}

func newPlatformController() (platformController, error) {
	return &unixController{}, nil
}

func (controller *unixController) Strategy() string { return "posix-process-group" }

func (controller *unixController) Configure(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func processGroupAlive(pid int) bool {
	err := syscall.Kill(-pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func waitForProcessGroupExit(pid int, grace time.Duration) bool {
	deadline := time.Now().Add(grace)
	for processGroupAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	return !processGroupAlive(pid)
}

func (controller *unixController) Terminate(pid int, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func (controller *unixController) CleanupAfterProviderExit(pid int, grace time.Duration) cleanupResult {
	if !processGroupAlive(pid) {
		return cleanupResult{Verified: true}
	}
	result := cleanupResult{Attempted: true}
	_ = controller.Terminate(pid, false)
	if waitForProcessGroupExit(pid, grace) {
		result.Verified = true
		return result
	}
	result.ForceUsed = true
	_ = controller.Terminate(pid, true)
	result.Verified = waitForProcessGroupExit(pid, grace)
	return result
}
