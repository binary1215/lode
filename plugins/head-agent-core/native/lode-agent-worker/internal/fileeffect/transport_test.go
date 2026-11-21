package fileeffect

import (
	"bytes"
	"encoding/json"
	"io"
	"runtime"
	"strings"
	"testing"
)

func transportFrame(t *testing.T, operation string, payload any) []byte {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(transportRequest{
		ProtocolVersion: TransportProtocolVersion, RequestID: "test-request.1",
		Operation: operation, MaxRequestBytes: TransportMaxBytes, MaxResponseBytes: 4096,
		PayloadDigest: digest(raw), Payload: raw,
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func callTransport(t *testing.T, frame []byte) (int, transportResponse, []byte) {
	t.Helper()
	var output bytes.Buffer
	code := RunTransport(bytes.NewReader(frame), &output)
	var response transportResponse
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("non-JSON response %q: %v", output.String(), err)
	}
	if response.ProtocolVersion != TransportProtocolVersion || response.AuthorityEffect != "none" {
		t.Fatalf("invalid response boundary: %+v", response)
	}
	return code, response, output.Bytes()
}

func TestTransportRejectsMalformedFrames(t *testing.T) {
	valid := transportFrame(t, "probe", probePayload{Root: "unused", Path: "owned.txt"})
	for name, frame := range map[string][]byte{
		"empty":       nil,
		"array":       []byte("[]"),
		"malformed":   []byte("{"),
		"trailing":    append(append([]byte(nil), valid...), []byte(" {}")...),
		"unknown":     []byte(strings.Replace(string(valid), `"operation":"probe"`, `"operation":"probe","extra":true`, 1)),
		"duplicate":   []byte(strings.Replace(string(valid), `"operation":"probe"`, `"operation":"probe","operation":"edit"`, 1)),
		"case":        []byte(strings.Replace(string(valid), `"operation"`, `"Operation"`, 1)),
		"null":        []byte(strings.Replace(string(valid), `"requestId":"test-request.1"`, `"requestId":null`, 1)),
		"bad-version": []byte(strings.Replace(string(valid), `"0.1.0"`, `"9.0.0"`, 1)),
		"create":      []byte(strings.Replace(string(valid), `"operation":"probe"`, `"operation":"create"`, 1)),
		"too-deep":    []byte(strings.Repeat("[", 18) + "0" + strings.Repeat("]", 18)),
	} {
		t.Run(name, func(t *testing.T) {
			code, response, output := callTransport(t, frame)
			if code != 2 || response.Status != "error" || response.Result != nil || response.Error == nil || len(output) > 4096 {
				t.Fatalf("bad rejection: %d %+v", code, response)
			}
		})
	}
}

type repeatedReader struct{ read int }

func (r *repeatedReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	r.read += len(p)
	return len(p), nil
}

func TestTransportBoundsBeforeExecution(t *testing.T) {
	input := &repeatedReader{}
	var output bytes.Buffer
	if code := RunTransport(input, &output); code != 2 || input.read != TransportMaxBytes+1 || output.Len() > 4096 {
		t.Fatalf("unbounded read/response: %d %d %d", code, input.read, output.Len())
	}
	valid := transportFrame(t, "probe", probePayload{Root: "unused", Path: "owned.txt"})
	for _, frame := range [][]byte{
		[]byte(strings.Replace(string(valid), `"maxRequestBytes":8388608`, `"maxRequestBytes":1`, 1)),
		[]byte(strings.Replace(string(valid), `"maxRequestBytes":8388608`, `"maxRequestBytes":8388609`, 1)),
		[]byte(strings.Replace(string(valid), `"maxResponseBytes":4096`, `"maxResponseBytes":1`, 1)),
		[]byte(strings.Replace(string(valid), `"maxResponseBytes":4096`, `"maxResponseBytes":8388609`, 1)),
		transportFrame(t, "probe", probePayload{Root: "unused", Path: strings.Repeat("nested/", 30) + "file"}),
	} {
		code, response, _ := callTransport(t, frame)
		if code != 2 || response.Error == nil || !strings.HasSuffix(response.Error.Code, "_LIMIT") || response.Result != nil {
			t.Fatalf("limit did not fail closed: %d %+v", code, response)
		}
	}
}

func TestTransportRejectsPayloadAmbiguityAndDigest(t *testing.T) {
	valid := transportFrame(t, "probe", probePayload{Root: "unused", Path: "owned.txt"})
	wrongDigest := []byte(strings.Replace(string(valid), `"owned.txt"`, `"other.txt"`, 1))
	for _, frame := range [][]byte{
		wrongDigest,
		transportFrame(t, "probe", map[string]any{"root": "unused", "path": "owned.txt", "phase": "intent-durable"}),
		transportFrame(t, "probe", map[string]any{"root": "unused", "Path": "owned.txt"}),
		transportFrame(t, "probe", json.RawMessage(`{"root":"unused","path":"owned.txt","path":"other.txt"}`)),
	} {
		code, response, _ := callTransport(t, frame)
		if code != 2 || response.Error == nil || response.Result != nil {
			t.Fatalf("invalid payload accepted: %d %+v", code, response)
		}
	}
}

type shortOutput struct{}

func (shortOutput) Write(p []byte) (int, error) { return len(p) - 1, nil }

type errorInput struct{}

func (errorInput) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestTransportIOFailureFailsClosed(t *testing.T) {
	if RunTransport(strings.NewReader("{}"), shortOutput{}) != 2 {
		t.Fatal("short output reported success")
	}
	var output bytes.Buffer
	if RunTransport(errorInput{}, &output) != 2 || !strings.Contains(output.String(), "FILE_EFFECT_INPUT_IO") {
		t.Fatal("read failure reported success")
	}
}

func TestTransportUnsupportedPlatformIsExplicit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unsupported-platform behavior is tested on non-Windows builds")
	}
	code, response, _ := callTransport(t, transportFrame(t, "probe", probePayload{Root: "/unopened-root", Path: "file"}))
	if code != 2 || response.Error == nil || response.Error.Code != "FILE_EFFECT_UNSUPPORTED" || response.Result != nil {
		t.Fatalf("unsupported platform hidden: %d %+v", code, response)
	}
}
