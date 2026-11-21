//go:build !windows

package processsupervisor

import (
	"errors"
	"os/exec"
)

const detachedOwnerStrategy = "unavailable"
const DetachedJobOwnerSupported = false

func configureDetachedOwner(command *exec.Cmd) error {
	// The existing attached path remains supported. A detached outer group is
	// not enough to own nested provider groups; never advertise that as cleanup.
	return errors.New("detached nested job ownership requires a verified session-wide cleanup adapter on this platform")
}
