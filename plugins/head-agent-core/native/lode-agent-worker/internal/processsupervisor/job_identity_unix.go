//go:build !windows

package processsupervisor

// Detached nested ownership is not enabled on these platforms yet.
func observeOwnerProcess(pid int) (string, string) { return "", "unknown" }
func ownProcessToken() string                      { return "" }
