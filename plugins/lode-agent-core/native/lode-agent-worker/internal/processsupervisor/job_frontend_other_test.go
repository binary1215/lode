//go:build !windows

package processsupervisor

// Only Windows places the shipped launcher in a frontend job object.
func enterFrontendJob() error { return nil }
