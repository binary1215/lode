//go:build windows

package processsupervisor

import (
	"os/exec"
	"syscall"
)

const detachedOwnerStrategy = "windows-explicit-job-breakaway"
const DetachedJobOwnerSupported = true

func configureDetachedOwner(command *exec.Cmd) error {
	// Failure to leave a lifetime Job is a launch failure; do not silently fall
	// back to an attached process and claim durable ownership. Provider sandbox
	// restrictions must still be established by the execution adapter.
	const detachedProcess = 0x00000008
	const createNewProcessGroup = 0x00000200
	const createBreakawayFromJob = 0x01000000
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true,
		CreationFlags: detachedProcess | createNewProcessGroup | createBreakawayFromJob}
	return nil
}
