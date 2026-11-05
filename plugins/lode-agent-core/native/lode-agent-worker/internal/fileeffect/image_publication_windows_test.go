//go:build windows

package fileeffect

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func unpublishedImageFixture(t *testing.T) (ImageEffect, string) {
	t.Helper()
	effect, journal := imageFixture(t)
	directory := filepath.Join(effect.Root, "nested")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	effect.Path = "nested/owned.txt"
	if err := os.WriteFile(filepath.Join(directory, "owned.txt"), effect.Before.Content, 0600); err != nil {
		t.Fatal(err)
	}
	var err error
	effect.AncestorIdentities, err = ProbeAncestorIdentities(effect.Root, effect.Path)
	if err != nil {
		t.Fatal(err)
	}
	return effect, journal
}

func decodeImageOutcome(t *testing.T, response transportResponse) ImageOutcome {
	t.Helper()
	b, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	var out ImageOutcome
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestImageInitialNonpublicationBindsExactResponseAndRedelivery(t *testing.T) {
	effect, journal := unpublishedImageFixture(t)
	frame := transportFrame(t, "image-apply", imagePayload{effect, journal})
	var request transportRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		t.Fatal(err)
	}
	wanted := imageInitialOutcome(effect)
	restore := replaceImageParent(t, effect)
	for attempt := 0; attempt < 2; attempt++ {
		code, response, _ := callTransport(t, frame)
		out := decodeImageOutcome(t, response)
		if code != 2 || response.Status != "error" || response.Error.Code != "FILE_EFFECT_CONFLICT" ||
			response.RequestDigest != digest(frame) || response.PayloadDigest != request.PayloadDigest ||
			response.RequestID != request.RequestID || response.Operation != "image-apply" ||
			out.IntentPublication != "not-attempted" || out.Status != "not-started" || out.IntentID != wanted.IntentID ||
			out.BeforeImageDigest != wanted.BeforeImageDigest || out.AfterImageDigest != wanted.AfterImageDigest || out.DataFlushed {
			t.Fatalf("unbound nonpublication response: %+v / %+v", response, out)
		}
		if len(snapshotFiles(t, journal)) != 0 {
			t.Fatal("nonpublication response wrote journal")
		}
	}
	restore()
	code, response, _ := callTransport(t, frame)
	out := decodeImageOutcome(t, response)
	if code != 0 || out.Status != "effect-observed" || out.IntentID != wanted.IntentID || out.IntentPublication != "" {
		t.Fatalf("exact redelivery did not apply: %+v / %+v", response, out)
	}
	inspection, err := InspectImageEffect(effect, journal)
	if err != nil || !inspection.CompletionRecorded {
		t.Fatalf("terminal-only field changed journal contract: %+v %v", inspection, err)
	}
	code, response, _ = callTransport(t, frame)
	if code != 2 || response.Error.Code != "FILE_EFFECT_ALREADY_EXISTS" || decodeImageOutcome(t, response).IntentPublication != "" {
		t.Fatalf("redelivery bypassed create-only boundary: %+v", response)
	}
}

func TestImageNonpublicationDoesNotHideExistingOrOrphanRecords(t *testing.T) {
	for _, suffix := range []string{".intent.json", ".partial.intent.json", ".started.json", ".not-started.json", ".completed.json"} {
		t.Run(suffix, func(t *testing.T) {
			effect, journal := unpublishedImageFixture(t)
			id := imageInitialOutcome(effect).IntentID
			fileSuffix := suffix
			content, _ := json.Marshal(effect)
			if suffix == ".partial.intent.json" {
				fileSuffix, content = ".intent.json", []byte("{")
			}
			file := filepath.Join(journal, id+fileSuffix)
			if err := os.WriteFile(file, content, 0600); err != nil {
				t.Fatal(err)
			}
			restore := replaceImageParent(t, effect)
			out, err := ApplyImageEffect(effect, journal, nil)
			if !errors.Is(err, errImageAncestor) || out.IntentPublication != "" {
				t.Fatalf("existing/orphan record hidden: %+v %v", out, err)
			}
			actual, err := os.ReadFile(file)
			if err != nil || !bytes.Equal(actual, content) || len(snapshotFiles(t, journal)) != 1 {
				t.Fatal("existing/orphan record changed")
			}
			restore()
		})
	}
}

func TestImageNonpublicationIsNotGlobalAbsenceOrFuturePermission(t *testing.T) {
	effect, journal := unpublishedImageFixture(t)
	restore := replaceImageParent(t, effect)
	out, err := ApplyImageEffect(effect, journal, nil)
	if err == nil || out.IntentPublication != "not-attempted" {
		t.Fatalf("missing invocation phase: %+v %v", out, err)
	}
	restore()
	// Another invocation can publish after that terminal observation. A fresh
	// delivery still crosses CREATE_NEW; the earlier response grants nothing.
	file := filepath.Join(journal, out.IntentID+".intent.json")
	partial := []byte("{")
	if err := os.WriteFile(file, partial, 0600); err != nil {
		t.Fatal(err)
	}
	next, err := ApplyImageEffect(effect, journal, nil)
	if !errors.Is(err, os.ErrExist) || next.IntentPublication != "" {
		t.Fatalf("old response permitted overwriting another intent: %+v %v", next, err)
	}
	actual, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(actual, partial) {
		t.Fatal("partial rival intent changed")
	}
	actual, err = os.ReadFile(filepath.Join(effect.Root, filepath.FromSlash(effect.Path)))
	if err != nil || !bytes.Equal(actual, effect.Before.Content) {
		t.Fatal("rival collision changed source")
	}
}

func TestImagePublicationAttemptNeverGetsNonpublicationEvidence(t *testing.T) {
	effect, journal := unpublishedImageFixture(t)
	var restore func()
	out, err := ApplyImageEffect(effect, journal, func(stage string) {
		if stage == "intent-durable" {
			restore = replaceImageParent(t, effect)
		}
	})
	if err == nil || out.Status != "not-started" || out.IntentPublication != "" {
		t.Fatalf("durable publication mislabeled: %+v %v", out, err)
	}
	restore()
	inspection, err := InspectImageEffect(effect, journal)
	if err != nil || !inspection.NoWriteRecorded || !inspection.RetryBasisAvailable {
		t.Fatalf("existing native no-write contract changed: %+v %v", inspection, err)
	}
	retry, err := RetryKnownNoImageEffect(effect, journal, nil)
	if err != nil || retry.Status != "effect-observed" || retry.IntentPublication != "" || retry.IntentID == out.IntentID {
		t.Fatalf("linked retry contract changed: %+v %v", retry, err)
	}
}

func TestImageNonpublicationRequiresInitialValidEffectAndSafeJournal(t *testing.T) {
	for _, kind := range []string{"invalid-effect", "invalid-journal", "missing-journal", "non-directory-journal", "non-initial", "unsupported"} {
		t.Run(kind, func(t *testing.T) {
			effect, journal := imageFixture(t)
			wantedPhase := ""
			switch kind {
			case "invalid-effect":
				effect.Path = "../outside.txt"
			case "invalid-journal":
				journal = effect.Root
			case "missing-journal":
				journal = filepath.Join(journal, "missing")
			case "non-directory-journal":
				journal = filepath.Join(journal, "file")
				if err := os.WriteFile(journal, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			case "non-initial":
				effect.PreviousIntentID = imageInitialOutcome(effect).IntentID
				effect.After.Mode = 0644 // Stop before predecessor I/O, still no proof.
			case "unsupported":
				effect.After.Mode = 0644
				wantedPhase = "not-attempted"
			}
			out, err := ApplyImageEffect(effect, journal, nil)
			if err == nil || out.IntentPublication != wantedPhase {
				t.Fatalf("%s: %+v %v", kind, out, err)
			}
			if kind == "unsupported" && !errors.Is(err, ErrUnsupported) {
				t.Fatal("phase erased unsupported capability")
			}
		})
	}
}

func TestImageNonpublicationCannotBeSuppliedByTransportCaller(t *testing.T) {
	effect, journal := imageFixture(t)
	frame := transportFrame(t, "image-apply", imagePayload{effect, journal})
	var request map[string]any
	if err := json.Unmarshal(frame, &request); err != nil {
		t.Fatal(err)
	}
	payload := request["payload"].(map[string]any)
	payload["effect"].(map[string]any)["intentPublication"] = "not-attempted"
	b, _ := json.Marshal(payload)
	request["payloadDigest"] = digest(b)
	frame, _ = json.Marshal(request)
	code, response, _ := callTransport(t, frame)
	if code != 2 || response.Error.Code != "FILE_EFFECT_INVALID_PAYLOAD" || response.Result != nil || len(snapshotFiles(t, journal)) != 0 {
		t.Fatalf("caller injected source phase: %+v", response)
	}
}
