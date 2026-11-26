package processsupervisor

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// LaunchJob separates the bounded native owner from the calling frontend.
// Detachment concerns lifetime only, never provider permissions. A Host must
// enforce the bound execution policy separately before any provider is invoked.
// Lost launch acknowledgment is unknown: this entrypoint never retries a claim.
func LaunchJob(requestFile string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	return launchJob(requestFile, executable, []string{"--job", requestFile}, nil)
}

func launchJob(requestFile, executable string, args []string, extraEnv []string) error {
	job, _, data, resolved, err := readJobRequest(requestFile)
	if err != nil {
		return err
	}
	directory := filepath.Dir(resolved)
	command := exec.Command(executable, args...)
	// All control paths are absolute; the deeper job directory needlessly hits
	// Windows current-directory limits. Keep the already authorized project cwd.
	command.Dir = job.Request.WorkingDirectory
	command.Env = append(os.Environ(), extraEnv...)
	if err := configureDetachedOwner(command); err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	command.Env = append(command.Env, "HEAD_NATIVE_JOB_REQUEST_DIGEST="+digest)
	if _, err := os.Lstat(filepath.Join(directory, "claim.json")); err == nil || !os.IsNotExist(err) {
		return errors.New("job owner already claimed or claim state is unreadable")
	}
	if err := writeJobRecord(filepath.Join(directory, "launch-intent.json"), map[string]any{
		"protocolVersion": JobProtocolVersion, "requestDigest": digest, "launcherPid": os.Getpid(),
		"replayAllowed": false, "authority": "host-operational-only",
	}); err != nil {
		return fmt.Errorf("launch intent already exists or is uncertain; inspect without replay: %w", err)
	}
	// Null stdio prevents the frontend pipe or console from owning job lifetime.
	// The owner persists bounded output and terminal evidence in the job folder.
	if err := command.Start(); err != nil {
		// Only Start failure is a proven non-start. An acknowledgment publication
		// failure after Start must never be reclassified as safe-to-relaunch.
		_ = writeJobRecord(filepath.Join(directory, "launch-failure.json"), map[string]any{
			"protocolVersion": JobProtocolVersion, "requestDigest": digest, "started": false,
		})
		return err
	}
	pid := command.Process.Pid
	ownerToken, _ := observeOwnerProcess(pid)
	ack := map[string]any{"protocolVersion": JobProtocolVersion, "requestDigest": digest,
		"ownerPid": pid, "ownerToken": ownerToken, "launcherPid": os.Getpid(), "ownerTerminalRequired": true,
		"lifetimeStrategy": detachedOwnerStrategy, "authority": "host-operational-only"}
	writeErr := writeJobRecord(filepath.Join(directory, "launch.json"), ack)
	releaseErr := command.Process.Release()
	if writeErr != nil {
		return fmt.Errorf("owner launch acknowledgment uncertain; inspect without replay: %w", writeErr)
	}
	if releaseErr != nil {
		return releaseErr
	}
	return json.NewEncoder(os.Stdout).Encode(ack)
}
