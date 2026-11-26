// Package fileeffect implements a small Host file effect, not Core authority.
// It does not launch providers, interpret instructions, or change recovery state.
package fileeffect

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Edit struct {
	Root               string   `json:"root"`
	RootIdentity       string   `json:"rootIdentity"`
	AncestorIdentities []string `json:"ancestorIdentities"`
	Path               string   `json:"path"`
	Before             []byte   `json:"before"`
	After              []byte   `json:"after"`
	MaxBytes           int64    `json:"maxBytes"`
	PreviousIntentID   string   `json:"previousIntentId,omitempty"`
}

type Outcome struct {
	Status          string `json:"status"`
	IntentID        string `json:"intentId"`
	BeforeDigest    string `json:"beforeDigest"`
	AfterDigest     string `json:"afterDigest"`
	CurrentDigest   string `json:"currentDigest,omitempty"`
	MetadataCAS     bool   `json:"metadataCAS"`
	MultiFileAtomic bool   `json:"multiFileAtomic"`
}

type Inspection struct {
	IntentID            string `json:"intentId"`
	Status              string `json:"status"`
	StartedRecorded     bool   `json:"startedRecorded"`
	NoWriteRecorded     bool   `json:"noWriteRecorded"`
	CompletionRecorded  bool   `json:"completionRecorded"`
	CurrentDigest       string `json:"currentDigest,omitempty"`
	RetryBasisAvailable bool   `json:"retryBasisAvailable"`
	AppliedByThisRead   bool   `json:"appliedByThisRead"`
}

var ErrConflict = errors.New("file effect conflict")
var ErrUnsupported = errors.New("file effect platform unsupported")

func digest(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }

func validate(edit Edit) error {
	if !filepath.IsAbs(edit.Root) || filepath.Clean(edit.Root) != edit.Root || edit.RootIdentity == "" || edit.Path == "" || edit.MaxBytes < 0 ||
		int64(len(edit.Before)) > edit.MaxBytes || int64(len(edit.After)) > edit.MaxBytes {
		return fmt.Errorf("%w: invalid bounded edit", ErrConflict)
	}
	for _, p := range strings.Split(edit.Path, "/") {
		if p == "" || p == "." || p == ".." || strings.ContainsAny(p, "\\:\x00<>\"|?*") || strings.TrimRight(p, ". ") != p || strings.EqualFold(p, ".head") || strings.EqualFold(p, ".git") {
			return fmt.Errorf("%w: invalid owned path", ErrConflict)
		}
		name := strings.ToUpper(strings.Split(p, ".")[0])
		if name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" ||
			len(name) == 4 && (strings.HasPrefix(name, "COM") || strings.HasPrefix(name, "LPT")) && name[3] >= '1' && name[3] <= '9' {
			return fmt.Errorf("%w: device alias", ErrConflict)
		}
	}
	if len(edit.AncestorIdentities) != len(strings.Split(edit.Path, "/")) || edit.AncestorIdentities[0] != edit.RootIdentity {
		return fmt.Errorf("%w: missing ancestor identity binding", ErrConflict)
	}
	for _, identity := range edit.AncestorIdentities {
		if identity == "" {
			return fmt.Errorf("%w: empty ancestor identity", ErrConflict)
		}
	}
	return nil
}

// syncNew is create-only. A partial intent cannot be used as proof of applied
// bytes. The journal stores the complete preimage before the first target write.
func syncNew(file string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	return f.Sync()
}

// EditExisting is intentionally existing-regular-file only. Its journal is
// Host-local P5, not durable Product/Run authority. No automatic retry or rollback
// occurs after an existing intent: reconciliation observes current bytes only.
// phase is an internal test seam; production callers must pass nil. The public
// CLI does not expose this primitive until Core integration is connected.
func EditExisting(edit Edit, journal string, phase func(string)) (Outcome, error) {
	out := Outcome{Status: "not-started", BeforeDigest: digest(edit.Before), AfterDigest: digest(edit.After)}
	if err := validate(edit); err != nil {
		return out, err
	}
	if bytes.Equal(edit.Before, edit.After) {
		return out, fmt.Errorf("%w: no effect", ErrConflict)
	}
	if !filepath.IsAbs(journal) || filepath.Clean(journal) != journal {
		return out, fmt.Errorf("%w: invalid journal", ErrConflict)
	}
	// Journal must be an already prepared directory outside the source root.
	rel, err := filepath.Rel(edit.Root, journal)
	if err != nil || rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return out, fmt.Errorf("%w: journal overlaps source", ErrConflict)
	}
	if err := plainDirectory(journal); err != nil {
		return out, err
	}
	releaseJournal, err := holdDirectory(journal)
	if err != nil {
		return out, err
	}
	defer releaseJournal()
	if edit.PreviousIntentID != "" {
		if err := verifyRetryPredecessor(edit, journal); err != nil {
			return out, err
		}
	}
	b, _ := json.Marshal(edit)
	out.IntentID = "file-effect-" + digest(b)
	intent := filepath.Join(journal, out.IntentID+".intent.json")
	// Never overwrite or silently rerun an earlier effect, even if current bytes
	// happen to equal its preimage. An earlier native crash may have taken effect.
	if err := syncNew(intent, edit); err != nil {
		return out, err
	}
	if phase != nil {
		phase("intent-durable")
	}
	writePossible := false
	err = lockedEdit(edit, func() error {
		if err := syncNew(filepath.Join(journal, out.IntentID+".started.json"), map[string]string{"intentId": out.IntentID, "phase": "before-first-write"}); err != nil {
			return err
		}
		if phase != nil {
			phase("before-first-write")
		}
		writePossible = true
		return nil
	}, phase)
	if err != nil {
		if writePossible {
			out.Status = "incomplete-or-conflict"
		} else {
			out.Status = "not-started"
			if recordErr := syncNew(filepath.Join(journal, out.IntentID+".not-started.json"), out); recordErr != nil {
				return out, errors.Join(err, recordErr)
			}
		}
		return out, err
	}
	out.Status = "bytes-flushed"
	out.CurrentDigest = out.AfterDigest
	if phase != nil {
		phase("before-journal-ack")
	}
	if err := syncNew(filepath.Join(journal, out.IntentID+".completed.json"), out); err != nil {
		return out, err
	}
	return out, nil
}

func plainDirectory(directory string) error {
	for cursor := directory; ; cursor = filepath.Dir(cursor) {
		info, err := os.Lstat(cursor)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: linked/non-directory ancestor", ErrConflict)
		}
		if filepath.Dir(cursor) == cursor {
			break
		}
	}
	return nil
}

// InspectExisting never retries, rolls back or repairs an effect. Current bytes
// and durable phase evidence are separate: a postimage without acknowledgment
// is not promoted to an operation-completed receipt, and neither-image bytes
// are not blamed on the user (they may be our own interrupted write).
func InspectExisting(edit Edit, journal string) (Inspection, error) {
	out := Inspection{Status: "unknown"}
	if err := validate(edit); err != nil {
		return out, err
	}
	if !filepath.IsAbs(journal) || filepath.Clean(journal) != journal {
		return out, ErrConflict
	}
	release, err := holdDirectory(journal)
	if err != nil {
		return out, err
	}
	defer release()
	b, _ := json.Marshal(edit)
	out.IntentID = "file-effect-" + digest(b)
	check := func(suffix string, expected any, required bool) (bool, error) {
		wanted, _ := json.Marshal(expected)
		actual, err := readRegularBounded(filepath.Join(journal, out.IntentID+suffix), int64(len(wanted)))
		if err != nil {
			if !required && errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return false, err
		}
		if !bytes.Equal(actual, wanted) {
			return false, fmt.Errorf("%w: journal differs from exact intent/phase", ErrConflict)
		}
		return true, nil
	}
	if _, err := check(".intent.json", edit, true); err != nil {
		return out, err
	}
	out.StartedRecorded, err = check(".started.json", map[string]string{"intentId": out.IntentID, "phase": "before-first-write"}, false)
	if err != nil {
		return out, err
	}
	notStarted := Outcome{Status: "not-started", IntentID: out.IntentID, BeforeDigest: digest(edit.Before), AfterDigest: digest(edit.After)}
	out.NoWriteRecorded, err = check(".not-started.json", notStarted, false)
	if err != nil {
		return out, err
	}
	completed := notStarted
	completed.Status = "bytes-flushed"
	completed.CurrentDigest = completed.AfterDigest
	out.CompletionRecorded, err = check(".completed.json", completed, false)
	if err != nil {
		return out, err
	}
	if out.CompletionRecorded && (!out.StartedRecorded || out.NoWriteRecorded) {
		return out, ErrConflict
	}
	identities, err := ProbeAncestorIdentities(edit.Root, edit.Path)
	if err != nil || !equalStrings(identities, edit.AncestorIdentities) {
		out.Status = "current-ancestor-conflict"
		return out, nil
	}
	current, err := readRegularBounded(filepath.Join(edit.Root, filepath.FromSlash(edit.Path)), int64(max(len(edit.Before), len(edit.After))))
	if err != nil {
		out.Status = "unverifiable-current"
		return out, nil
	}
	out.CurrentDigest = digest(current)
	switch {
	case bytes.Equal(current, edit.After):
		out.Status = "postimage-observed"
	case bytes.Equal(current, edit.Before):
		out.Status = "preimage-observed"
		out.RetryBasisAvailable = out.NoWriteRecorded
	default:
		out.Status = "partial-or-concurrent"
	}
	return out, nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// RetryKnownNoWrite creates a different, linked attempt only when the prior
// native invocation durably recorded no write and its source basis still holds.
// Simultaneous callers derive the same create-only intent; one wins publication.
func RetryKnownNoWrite(previous Edit, journal string, phase func(string)) (Outcome, error) {
	inspection, err := InspectExisting(previous, journal)
	if err != nil {
		return Outcome{Status: "not-started"}, err
	}
	if !inspection.RetryBasisAvailable {
		return Outcome{Status: "not-started"}, fmt.Errorf("%w: predecessor has no current known-no-write basis", ErrConflict)
	}
	next := previous
	next.PreviousIntentID = inspection.IntentID
	return EditExisting(next, journal, phase)
}

func verifyRetryPredecessor(edit Edit, journal string) error {
	id := edit.PreviousIntentID
	if len(id) != len("file-effect-")+64 || !strings.HasPrefix(id, "file-effect-") {
		return ErrConflict
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(id, "file-effect-"))
	if err != nil || len(decoded) != 32 {
		return ErrConflict
	}
	encoded, _ := json.Marshal(edit)
	data, err := readRegularBounded(filepath.Join(journal, id+".intent.json"), int64(len(encoded)+128))
	if err != nil {
		return err
	}
	var prior Edit
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&prior); err != nil {
		return err
	}
	canonical, _ := json.Marshal(prior)
	if !bytes.Equal(data, canonical) || "file-effect-"+digest(data) != id {
		return ErrConflict
	}
	priorComparable := prior
	priorComparable.PreviousIntentID = ""
	currentComparable := edit
	currentComparable.PreviousIntentID = ""
	a, _ := json.Marshal(priorComparable)
	b, _ := json.Marshal(currentComparable)
	if !bytes.Equal(a, b) {
		return fmt.Errorf("%w: retry changes effect or source basis", ErrConflict)
	}
	inspection, err := InspectExisting(prior, journal)
	if err != nil {
		return err
	}
	if !inspection.RetryBasisAvailable {
		return fmt.Errorf("%w: uncertain or changed predecessor cannot be retried", ErrConflict)
	}
	return nil
}
