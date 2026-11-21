//go:build windows

package fileeffect

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func snapshotFiles(t *testing.T, directory string) map[string]string {
	t.Helper()
	files, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(directory, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		result[file.Name()] = string(data)
	}
	return result
}

func TestTransportRoundtripAndReadonlyInspection(t *testing.T) {
	edit, journal := fixture(t)
	probeFrame := transportFrame(t, "probe", probePayload{Root: edit.Root, Path: edit.Path})
	code, probeResponse, _ := callTransport(t, probeFrame)
	if code != 0 || probeResponse.Status != "ok" || probeResponse.RequestID != "test-request.1" || probeResponse.RequestDigest != digest(probeFrame) || probeResponse.Operation != "probe" {
		t.Fatalf("probe binding: %d %+v", code, probeResponse)
	}
	encodedProbe, _ := json.Marshal(probeResponse.Result)
	var observed probeResult
	if err := json.Unmarshal(encodedProbe, &observed); err != nil || observed.RootIdentity != edit.RootIdentity || !equalStrings(observed.AncestorIdentities, edit.AncestorIdentities) {
		t.Fatalf("probe result: %+v %v", observed, err)
	}
	if files := snapshotFiles(t, journal); len(files) != 0 {
		t.Fatal("probe wrote journal")
	}
	payload := effectPayload{Edit: edit, Journal: journal}
	code, missing, _ := callTransport(t, transportFrame(t, "inspect", payload))
	if code != 2 || missing.Status != "error" || missing.Error.Code != "FILE_EFFECT_NOT_FOUND" || len(snapshotFiles(t, journal)) != 0 {
		t.Fatalf("missing inspect mutated: %d %+v", code, missing)
	}
	frame := transportFrame(t, "edit", payload)
	code, effect, _ := callTransport(t, frame)
	if code != 0 || effect.Status != "ok" || effect.RequestDigest != digest(frame) || effect.PayloadDigest == "" {
		t.Fatalf("effect: %d %+v", code, effect)
	}
	resultBytes, _ := json.Marshal(effect.Result)
	var outcome Outcome
	if err := json.Unmarshal(resultBytes, &outcome); err != nil || outcome.Status != "bytes-flushed" || outcome.MetadataCAS || outcome.MultiFileAtomic {
		t.Fatalf("outcome %+v %v", outcome, err)
	}
	beforeJournal, _ := json.Marshal(snapshotFiles(t, journal))
	code, inspection, _ := callTransport(t, transportFrame(t, "inspect", payload))
	if code != 0 || inspection.Status != "ok" {
		t.Fatalf("inspection: %d %+v", code, inspection)
	}
	resultBytes, _ = json.Marshal(inspection.Result)
	var evidence Inspection
	if err := json.Unmarshal(resultBytes, &evidence); err != nil || !evidence.CompletionRecorded || evidence.Status != "postimage-observed" || evidence.AppliedByThisRead {
		t.Fatalf("inspection %+v %v", evidence, err)
	}
	afterJournal, _ := json.Marshal(snapshotFiles(t, journal))
	current, err := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if err != nil || !bytes.Equal(current, edit.After) || !bytes.Equal(beforeJournal, afterJournal) {
		t.Fatal("inspection changed source or journal")
	}
	code, replay, _ := callTransport(t, frame)
	if code != 2 || replay.Error.Code != "FILE_EFFECT_ALREADY_EXISTS" || replay.Result == nil {
		t.Fatalf("replay or evidence loss: %d %+v", code, replay)
	}
}

func TestTransportInvalidEffectDoesNotWrite(t *testing.T) {
	edit, journal := fixture(t)
	raw, _ := json.Marshal(effectPayload{Edit: edit, Journal: journal})
	variants := []json.RawMessage{
		[]byte(strings.Replace(string(raw), `"maxBytes":4096`, `"maxBytes":4096,"unknown":true`, 1)),
		[]byte(strings.Replace(string(raw), `"before":"YmVmb3Jl"`, `"before":null`, 1)),
		[]byte(strings.Replace(string(raw), `"before":"YmVmb3Jl"`, `"before":"YmVm\nb3Jl"`, 1)),
		[]byte(strings.Replace(string(raw), `"before":"YmVmb3Jl"`, `"Before":"YmVmb3Jl"`, 1)),
		[]byte(strings.Replace(string(raw), `"maxBytes":4096`, `"maxBytes":1`, 1)),
		[]byte(strings.Replace(string(raw), `"path":"owned.txt"`, `"path":"../escape.txt"`, 1)),
	}
	for _, payload := range variants {
		code, response, _ := callTransport(t, transportFrame(t, "edit", payload))
		if code != 2 || response.Status != "error" || response.Error.Code != "FILE_EFFECT_INVALID_PAYLOAD" || response.Result != nil {
			t.Fatalf("invalid edit accepted: %d %+v", code, response)
		}
		current, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
		if !bytes.Equal(current, edit.Before) || len(snapshotFiles(t, journal)) != 0 {
			t.Fatal("invalid request created an effect or journal")
		}
	}
}

func TestTransportBusyOutcomeAndKnownNoWriteRetry(t *testing.T) {
	edit, journal := fixture(t)
	p, err := syscall.UTF16PtrFromString(filepath.Join(edit.Root, edit.Path))
	if err != nil {
		t.Fatal(err)
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	payload := effectPayload{Edit: edit, Journal: journal}
	code, failure, _ := callTransport(t, transportFrame(t, "edit", payload))
	syscall.CloseHandle(h)
	if code != 2 || failure.Error.Code != "FILE_EFFECT_BUSY" || failure.Status != "error" || failure.Result == nil {
		t.Fatalf("busy was mislabeled: %d %+v", code, failure)
	}
	b, _ := json.Marshal(failure.Result)
	var outcome Outcome
	if err := json.Unmarshal(b, &outcome); err != nil || outcome.Status != "not-started" || outcome.IntentID == "" {
		t.Fatalf("lost no-write evidence: %+v %v", outcome, err)
	}
	code, retry, _ := callTransport(t, transportFrame(t, "retry", payload))
	if code != 0 || retry.Status != "ok" {
		t.Fatalf("known-no-write retry failed: %d %+v", code, retry)
	}
	current, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if !bytes.Equal(current, edit.After) {
		t.Fatal("retry postimage missing")
	}
	code, repeated, _ := callTransport(t, transportFrame(t, "retry", payload))
	if code != 2 || repeated.Status != "error" || repeated.Error.Code != "FILE_EFFECT_CONFLICT" {
		t.Fatalf("retry replay accepted: %d %+v", code, repeated)
	}
}
