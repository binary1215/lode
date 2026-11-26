package processsupervisor

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

func exactOwnerState(pid int, expected string, observe func(int) (string, string)) string {
	if pid < 1 || expected == "" {
		return "unknown"
	}
	actual, state := observe(pid)
	if state == "gone" {
		return "gone"
	}
	if actual != "" && actual != expected {
		return "reused"
	}
	if state == "present" && actual == expected {
		return "present"
	}
	return "unknown"
}

// InspectJobOwner accepts an exact job, not an arbitrary PID control operation.
// A reused PID proves the original owner exited; it grants no right to kill it.
func InspectJobOwner(requestFile string) error {
	// Read-only historical inspection must not require the old Node executable
	// or execution cwd to remain installed. Never pass this path to execution.
	resolved, err := canonicalJobRequestPath(requestFile)
	if err != nil {
		return errors.New("invalid inspection request path")
	}
	request, err := os.Open(resolved)
	if err != nil {
		return err
	}
	data, readErr := io.ReadAll(io.LimitReader(request, maxRequestBytes+1))
	_ = request.Close()
	if readErr != nil || len(data) > maxRequestBytes {
		return errors.New("invalid inspection request size")
	}
	var job JobRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&job) != nil || decoder.Decode(&struct{}{}) != io.EOF || job.ProtocolVersion != JobProtocolVersion {
		return errors.New("invalid inspection request")
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	state := "unknown"
	f, err := os.Open(filepath.Join(filepath.Dir(resolved), "claim.json"))
	if err == nil {
		bytes, readErr := io.ReadAll(io.LimitReader(f, 64*1024+1))
		_ = f.Close()
		if readErr != nil || len(bytes) > 64*1024 {
			return errors.New("invalid owner claim")
		}
		var claim struct {
			RequestDigest string `json:"requestDigest"`
			PID           int    `json:"pid"`
			OwnerToken    string `json:"ownerToken"`
		}
		if json.Unmarshal(bytes, &claim) != nil || claim.RequestDigest != digest {
			return errors.New("owner claim differs from request")
		}
		state = exactOwnerState(claim.PID, claim.OwnerToken, observeOwnerProcess)
	} else if !os.IsNotExist(err) {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"protocolVersion": JobProtocolVersion, "requestDigest": digest, "ownerState": state})
}
