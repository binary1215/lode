package fileeffect

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const ImageProtocolVersion = "0.1.0"

// An absent path and an empty regular file are distinct images. Windows mode
// support is deliberately narrower than POSIX chmod: no ACL mutation is done.
type Image struct {
	Kind    string
	Content []byte
	Mode    uint32
}

func (image Image) MarshalJSON() ([]byte, error) {
	if image.Kind == "absent" {
		if len(image.Content) != 0 || image.Mode != 0 {
			return nil, ErrConflict
		}
		return []byte(`{"kind":"absent"}`), nil
	}
	if image.Kind != "file" || image.Mode > 0777 {
		return nil, ErrConflict
	}
	return json.Marshal(struct {
		Kind    string `json:"kind"`
		Content string `json:"content"`
		Mode    uint32 `json:"mode"`
	}{"file", base64.StdEncoding.EncodeToString(image.Content), image.Mode})
}

func (image *Image) UnmarshalJSON(data []byte) error {
	var discriminator struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &discriminator); err != nil {
		return err
	}
	if discriminator.Kind == "absent" {
		if _, err := exactObject(data, []string{"kind"}, nil); err != nil {
			return err
		}
		*image = Image{Kind: "absent"}
		return nil
	}
	if discriminator.Kind != "file" {
		return ErrConflict
	}
	fields, err := exactObject(data, []string{"kind", "content", "mode"}, nil)
	if err != nil {
		return err
	}
	var encoded string
	var mode uint32
	if err := json.Unmarshal(fields["content"], &encoded); err != nil {
		return err
	}
	if err := json.Unmarshal(fields["mode"], &mode); err != nil || mode > 0777 {
		return ErrConflict
	}
	content, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(content) != encoded {
		return ErrConflict
	}
	*image = Image{Kind: "file", Content: content, Mode: mode}
	return nil
}

type ImageEffect struct {
	Root               string   `json:"root"`
	RootIdentity       string   `json:"rootIdentity"`
	AncestorIdentities []string `json:"ancestorIdentities"`
	Path               string   `json:"path"`
	Before             Image    `json:"before"`
	After              Image    `json:"after"`
	MaxBytes           int64    `json:"maxBytes"`
	PreviousIntentID   string   `json:"previousIntentId,omitempty"`
}

type ImagePreflight struct {
	Status             string   `json:"status"`
	Reason             string   `json:"reason"`
	Operation          string   `json:"operation"`
	RootIdentity       string   `json:"rootIdentity,omitempty"`
	AncestorIdentities []string `json:"ancestorIdentities,omitempty"`
	ModeSemantics      string   `json:"modeSemantics"`
	MetadataCAS        bool     `json:"metadataCAS"`
	MultiFileAtomic    bool     `json:"multiFileAtomic"`
}

type ImageOutcome struct {
	Status             string `json:"status"`
	IntentID           string `json:"intentId"`
	IntentPublication  string `json:"intentPublication,omitempty"`
	BeforeImageDigest  string `json:"beforeImageDigest"`
	AfterImageDigest   string `json:"afterImageDigest"`
	CurrentImageDigest string `json:"currentImageDigest,omitempty"`
	DataFlushed        bool   `json:"dataFlushed"`
	MetadataCAS        bool   `json:"metadataCAS"`
	MultiFileAtomic    bool   `json:"multiFileAtomic"`
}

type ImageInspection struct {
	IntentID            string `json:"intentId"`
	Status              string `json:"status"`
	StartedRecorded     bool   `json:"startedRecorded"`
	NoWriteRecorded     bool   `json:"noWriteRecorded"`
	CompletionRecorded  bool   `json:"completionRecorded"`
	CurrentImageDigest  string `json:"currentImageDigest,omitempty"`
	RetryBasisAvailable bool   `json:"retryBasisAvailable"`
	AppliedByThisRead   bool   `json:"appliedByThisRead"`
}

func imageDigest(image Image) string { b, _ := json.Marshal(image); return digest(b) }
func sameImage(a, b Image) bool {
	return a.Kind == b.Kind && a.Mode == b.Mode && bytes.Equal(a.Content, b.Content)
}
func imageOperation(effect ImageEffect) string {
	if effect.Before.Kind == "absent" {
		return "create"
	}
	if effect.After.Kind == "absent" {
		return "delete"
	}
	if !bytes.Equal(effect.Before.Content, effect.After.Content) {
		return "edit"
	}
	return "mode"
}

func validateImageEffect(effect ImageEffect, discovery bool) error {
	for _, image := range []Image{effect.Before, effect.After} {
		if _, err := image.MarshalJSON(); err != nil {
			return err
		}
		if int64(len(image.Content)) > effect.MaxBytes {
			return ErrConflict
		}
	}
	if sameImage(effect.Before, effect.After) {
		return fmt.Errorf("%w: no image effect", ErrConflict)
	}
	rootIdentity, ancestors := effect.RootIdentity, effect.AncestorIdentities
	if discovery && rootIdentity == "" && len(ancestors) == 0 {
		rootIdentity = "discovery"
		ancestors = make([]string, len(strings.Split(effect.Path, "/")))
		for i := range ancestors {
			ancestors[i] = rootIdentity
		}
	}
	return validate(Edit{Root: effect.Root, RootIdentity: rootIdentity, AncestorIdentities: ancestors,
		Path: effect.Path, Before: effect.Before.Content, After: effect.After.Content, MaxBytes: effect.MaxBytes})
}

func validateImageJournal(effect ImageEffect, journal string) error {
	if !filepath.IsAbs(journal) || filepath.Clean(journal) != journal {
		return ErrConflict
	}
	relative, err := filepath.Rel(effect.Root, journal)
	if err != nil || relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return ErrConflict
	}
	return nil
}

// Preflight never reserves a path or creates a parent/journal. Blank identity
// bindings are accepted only for this read-only capability/discovery operation.
func PreflightImageEffect(effect ImageEffect, journal string) (ImagePreflight, error) {
	out := ImagePreflight{Status: "unsupported", Operation: imageOperation(effect), ModeSemantics: "windows-readonly-attribute-only"}
	if err := validateImageEffect(effect, true); err != nil {
		return out, err
	}
	if err := validateImageJournal(effect, journal); err != nil {
		return out, err
	}
	return preflightImagePlatform(effect, out)
}

func imageInitialOutcome(effect ImageEffect) ImageOutcome {
	b, _ := json.Marshal(effect)
	return ImageOutcome{Status: "not-started", IntentID: "file-image-effect-" + digest(b),
		BeforeImageDigest: imageDigest(effect.Before), AfterImageDigest: imageDigest(effect.After)}
}

func imageCompletedOutcome(effect ImageEffect) ImageOutcome {
	out := imageInitialOutcome(effect)
	out.Status = "effect-observed"
	out.CurrentImageDigest = out.AfterImageDigest
	out.DataFlushed = imageOperation(effect) == "create" || imageOperation(effect) == "edit"
	return out
}

// ApplyImageEffect is one path, not a multi-file transaction. A rename-shaped
// patch remains independent create/delete effects and can be partially applied.
// No interrupted effect is retried or rolled back by this method.
func ApplyImageEffect(effect ImageEffect, journal string, phase func(string)) (ImageOutcome, error) {
	publicationAttempted := false
	out, err := applyImageEffect(effect, journal, phase, &publicationAttempted)
	if err != nil && !publicationAttempted && effect.PreviousIntentID == "" &&
		validateImageEffect(effect, false) == nil && validateImageJournal(effect, journal) == nil &&
		noImagePublicationRecordsObserved(journal, out.IntentID) {
		// This terminal response describes only this invocation's code path.
		// It is not a global absence claim, a durable journal record, or retry
		// permission. The Host must bind the exact verified transport response
		// and this owner's termination to its immutable logical attempt.
		out.IntentPublication = "not-attempted"
	}
	return out, err
}

// Do not conceal an existing, partial, inaccessible, or orphan phase record.
// Holding directories fences replacement, not concurrent file creation; these
// observations do not make the per-invocation publication phase a snapshot/CAS.
// A future delivery must still pass the create-only intent boundary itself.
func noImagePublicationRecordsObserved(journal, intentID string) bool {
	if err := plainDirectory(journal); err != nil {
		return false
	}
	release, err := holdDirectory(journal)
	if err != nil {
		return false
	}
	defer release()
	for _, suffix := range []string{".intent.json", ".started.json", ".not-started.json", ".completed.json"} {
		if _, err := os.Lstat(filepath.Join(journal, intentID+suffix)); !errors.Is(err, os.ErrNotExist) {
			return false
		}
	}
	return true
}

// publicationAttempted is an internal phase fact for linked retry reporting,
// never a wire-supplied permission or an inference from current source bytes.
func applyImageEffect(effect ImageEffect, journal string, phase func(string), publicationAttempted *bool) (ImageOutcome, error) {
	out := imageInitialOutcome(effect)
	if err := validateImageEffect(effect, false); err != nil {
		return out, err
	}
	preflight, err := PreflightImageEffect(effect, journal)
	if err != nil {
		return out, err
	}
	if preflight.Status != "supported" {
		return out, fmt.Errorf("%w: %s", ErrUnsupported, preflight.Reason)
	}
	if err := plainDirectory(journal); err != nil {
		return out, err
	}
	releaseJournal, err := holdDirectory(journal)
	if err != nil {
		return out, err
	}
	defer releaseJournal()
	if effect.PreviousIntentID != "" {
		if err := verifyImageRetryPredecessor(effect, journal); err != nil {
			return out, err
		}
	}
	if publicationAttempted != nil {
		*publicationAttempted = true
	}
	if err := syncNew(filepath.Join(journal, out.IntentID+".intent.json"), effect); err != nil {
		return out, err
	}
	if phase != nil {
		phase("intent-durable")
	}
	started := false
	knownNoEffect, err := lockedImageEffect(effect, func() error {
		if err := syncNew(filepath.Join(journal, out.IntentID+".started.json"), map[string]string{"intentId": out.IntentID, "phase": "before-first-effect"}); err != nil {
			return err
		}
		if phase != nil {
			phase("before-first-effect")
		}
		started = true
		return nil
	}, phase)
	if err != nil {
		if started && !knownNoEffect {
			out.Status = "incomplete-or-conflict"
		} else {
			if recordErr := syncNew(filepath.Join(journal, out.IntentID+".not-started.json"), out); recordErr != nil {
				return out, errors.Join(err, recordErr)
			}
		}
		return out, err
	}
	out = imageCompletedOutcome(effect)
	if phase != nil {
		phase("before-journal-ack")
	}
	if err := syncNew(filepath.Join(journal, out.IntentID+".completed.json"), out); err != nil {
		return out, err
	}
	return out, nil
}

func InspectImageEffect(effect ImageEffect, journal string) (ImageInspection, error) {
	out := ImageInspection{Status: "unknown", IntentID: imageInitialOutcome(effect).IntentID}
	if err := validateImageEffect(effect, false); err != nil {
		return out, err
	}
	if err := validateImageJournal(effect, journal); err != nil {
		return out, err
	}
	if err := plainDirectory(journal); err != nil {
		return out, err
	}
	release, err := holdDirectory(journal)
	if err != nil {
		return out, err
	}
	defer release()
	check := func(suffix string, expected any, required bool) (bool, error) {
		wanted, _ := json.Marshal(expected)
		actual, err := readRegularBounded(filepath.Join(journal, out.IntentID+suffix), int64(len(wanted)))
		if !required && errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !bytes.Equal(actual, wanted) {
			return false, ErrConflict
		}
		return true, nil
	}
	if _, err := check(".intent.json", effect, true); err != nil {
		return out, err
	}
	out.StartedRecorded, err = check(".started.json", map[string]string{"intentId": out.IntentID, "phase": "before-first-effect"}, false)
	if err != nil {
		return out, err
	}
	out.NoWriteRecorded, err = check(".not-started.json", imageInitialOutcome(effect), false)
	if err != nil {
		return out, err
	}
	out.CompletionRecorded, err = check(".completed.json", imageCompletedOutcome(effect), false)
	if err != nil {
		return out, err
	}
	if out.CompletionRecorded && (!out.StartedRecorded || out.NoWriteRecorded) {
		return out, ErrConflict
	}
	current, err := observeImagePlatform(effect)
	if errors.Is(err, errImageAncestor) {
		out.Status = "current-ancestor-conflict"
		return out, nil
	}
	if err != nil {
		out.Status = "unverifiable-current"
		return out, nil
	}
	out.CurrentImageDigest = imageDigest(current)
	switch {
	case sameImage(current, effect.After):
		out.Status = "postimage-observed"
	case sameImage(current, effect.Before):
		out.Status = "preimage-observed"
		out.RetryBasisAvailable = out.NoWriteRecorded
	default:
		out.Status = "partial-or-concurrent"
	}
	return out, nil
}

func RetryKnownNoImageEffect(previous ImageEffect, journal string, phase func(string)) (ImageOutcome, error) {
	inspection, err := InspectImageEffect(previous, journal)
	if err != nil {
		return imageInitialOutcome(previous), err
	}
	if !inspection.RetryBasisAvailable {
		return imageInitialOutcome(previous), ErrConflict
	}
	next := previous
	next.PreviousIntentID = inspection.IntentID
	if phase != nil {
		phase("retry-basis-verified")
	}
	publicationAttempted := false
	out, err := applyImageEffect(next, journal, phase, &publicationAttempted)
	if err != nil && !publicationAttempted {
		// The child operation was never offered to create-only publication. Keep
		// the verified predecessor as the retry anchor only when no child record
		// is observed. An existing, partial, inaccessible or possibly published
		// child remains visible; EEXIST and every post-publication error retain
		// the child identity and can never be relabeled as predecessor no-write.
		if _, inspectErr := os.Lstat(filepath.Join(journal, out.IntentID+".intent.json")); errors.Is(inspectErr, os.ErrNotExist) {
			return imageInitialOutcome(previous), err
		}
	}
	return out, err
}

func verifyImageRetryPredecessor(effect ImageEffect, journal string) error {
	id := effect.PreviousIntentID
	if !strings.HasPrefix(id, "file-image-effect-") {
		return ErrConflict
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(id, "file-image-effect-"))
	if err != nil || len(decoded) != 32 || id != strings.ToLower(id) {
		return ErrConflict
	}
	encoded, _ := json.Marshal(effect)
	data, err := readRegularBounded(filepath.Join(journal, id+".intent.json"), int64(len(encoded)+128))
	if err != nil {
		return err
	}
	var prior ImageEffect
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&prior); err != nil {
		return err
	}
	canonical, _ := json.Marshal(prior)
	if !bytes.Equal(data, canonical) || "file-image-effect-"+digest(data) != id {
		return ErrConflict
	}
	priorComparable, currentComparable := prior, effect
	priorComparable.PreviousIntentID, currentComparable.PreviousIntentID = "", ""
	a, _ := json.Marshal(priorComparable)
	b, _ := json.Marshal(currentComparable)
	if !bytes.Equal(a, b) {
		return ErrConflict
	}
	inspection, err := InspectImageEffect(prior, journal)
	if err != nil {
		return err
	}
	if !inspection.RetryBasisAvailable {
		return ErrConflict
	}
	return nil
}

var errImageAncestor = errors.New("file image ancestor conflict")
