//go:build !windows

package processsupervisor

import "errors"

func waitOwnedFixtureExit(pid int) error {
	return errors.New("nested detached cleanup is unverified on this platform")
}
