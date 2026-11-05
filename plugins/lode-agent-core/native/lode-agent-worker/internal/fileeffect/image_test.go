package fileeffect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestImageEncodingIsStrictAndKindBound(t *testing.T) {
	for _, invalid := range []string{
		`{"kind":"absent","content":""}`,
		`{"kind":"absent","mode":0}`,
		`{"kind":"file","content":"","mode":512}`,
		`{"kind":"file","content":null,"mode":438}`,
		`{"kind":"file","content":"YQ\n==","mode":438}`,
		`{"kind":"file","contentBase64":"","mode":438}`,
		`{"kind":"file","content":"","mode":438,"authority":true}`,
	} {
		var image Image
		if err := json.Unmarshal([]byte(invalid), &image); err == nil {
			t.Fatalf("invalid image accepted: %s", invalid)
		}
	}
	for _, encoded := range []string{`{"kind":"absent"}`, `{"kind":"file","content":"","mode":438}`, `{"kind":"file","content":"YQ==","mode":292}`} {
		var image Image
		if err := json.Unmarshal([]byte(encoded), &image); err != nil {
			t.Fatal(err)
		}
		actual, err := json.Marshal(image)
		if err != nil || string(actual) != encoded {
			t.Fatalf("nonexact image %s %v", actual, err)
		}
	}
}

func TestImageTransportRejectsMalformedEffectBeforeIO(t *testing.T) {
	effect := ImageEffect{Root: filepath.Clean(os.TempDir()), Path: "unused", Before: Image{Kind: "absent"}, After: Image{Kind: "file", Content: []byte("new"), Mode: 0666}, MaxBytes: 4096, AncestorIdentities: []string{}}
	raw, _ := json.Marshal(imagePayload{effect, filepath.Join(filepath.Dir(effect.Root), "separate-journal")})
	for _, variant := range []string{
		strings.Replace(string(raw), `"maxBytes":4096`, `"maxBytes":4096,"phase":"create"`, 1),
		strings.Replace(string(raw), `"kind":"absent"`, `"kind":"absent","content":""`, 1),
		strings.Replace(string(raw), `"ancestorIdentities":[]`, `"ancestorIdentities":null`, 1),
	} {
		code, response, _ := callTransport(t, transportFrame(t, "image-preflight", json.RawMessage(variant)))
		if code != 2 || response.Error.Code != "FILE_EFFECT_INVALID_PAYLOAD" || response.Result != nil {
			t.Fatalf("malformed accepted: %+v", response)
		}
	}
	code, response, _ := callTransport(t, transportFrame(t, "image-apply", imagePayload{effect, filepath.Join(filepath.Dir(effect.Root), "separate-journal")}))
	if code != 2 || response.Error.Code != "FILE_EFFECT_INVALID_PAYLOAD" {
		t.Fatal("unbound discovery used as execution")
	}
}

func TestImagePreflightNonWindowsDisclosesUnsupported(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows contract")
	}
	effect := ImageEffect{Root: "/not-created", Path: "file", Before: Image{Kind: "absent"}, After: Image{Kind: "file", Content: []byte{}, Mode: 0666}, MaxBytes: 0, AncestorIdentities: []string{}}
	out, err := PreflightImageEffect(effect, "/not-created-journal")
	if err != nil || out.Status != "unsupported" || out.Reason != "platform-unsupported" {
		t.Fatalf("unsupported hidden: %+v %v", out, err)
	}
}
