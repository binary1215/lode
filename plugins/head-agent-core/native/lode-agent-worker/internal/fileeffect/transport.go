package fileeffect

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf8"
)

// TransportProtocolVersion identifies the internal Host effect wire contract.
// authorityEffect:none means no semantic authority, not absence of file writes.
const TransportProtocolVersion = "0.1.0"

// This is a transport allocation ceiling, not the per-file byte budget. It
// matches the existing supervisor request ceiling; Core supplies a lower bound.
const TransportMaxBytes = 8 * 1024 * 1024

type transportRequest struct {
	ProtocolVersion  string          `json:"protocolVersion"`
	RequestID        string          `json:"requestId"`
	Operation        string          `json:"operation"`
	MaxRequestBytes  int64           `json:"maxRequestBytes"`
	MaxResponseBytes int64           `json:"maxResponseBytes"`
	PayloadDigest    string          `json:"payloadDigest"`
	Payload          json.RawMessage `json:"payload"`
}

type transportResponse struct {
	ProtocolVersion string          `json:"protocolVersion"`
	RequestID       string          `json:"requestId,omitempty"`
	Operation       string          `json:"operation,omitempty"`
	PayloadDigest   string          `json:"payloadDigest,omitempty"`
	RequestDigest   string          `json:"requestDigest,omitempty"`
	Status          string          `json:"status"`
	AuthorityEffect string          `json:"authorityEffect"`
	Result          any             `json:"result,omitempty"`
	Error           *transportError `json:"error,omitempty"`
}

type transportError struct {
	Code string `json:"code"`
}

type probePayload struct {
	Root string `json:"root"`
	Path string `json:"path"`
}

type effectPayload struct {
	Edit    Edit   `json:"edit"`
	Journal string `json:"journal"`
}

type imagePayload struct {
	Effect  ImageEffect `json:"effect"`
	Journal string      `json:"journal"`
}

func validateImageTransportPayload(request transportRequest) (imagePayload, error) {
	var payload imagePayload
	fields, err := exactObject(request.Payload, []string{"effect", "journal"}, nil)
	if err != nil {
		return payload, err
	}
	if _, err := exactObject(fields["effect"], []string{"root", "rootIdentity", "ancestorIdentities", "path", "before", "after", "maxBytes"}, []string{"previousIntentId"}); err != nil {
		return payload, err
	}
	if err := json.Unmarshal(request.Payload, &payload); err != nil {
		return payload, err
	}
	if err := validateImageEffect(payload.Effect, request.Operation == "image-preflight"); err != nil {
		return payload, err
	}
	if err := validateImageJournal(payload.Effect, payload.Journal); err != nil {
		return payload, err
	}
	return payload, nil
}

type probeResult struct {
	RootIdentity       string   `json:"rootIdentity"`
	AncestorIdentities []string `json:"ancestorIdentities"`
}

// exactObject rejects missing, differently-cased, unknown, and null fields.
// Duplicate names (at every depth) are rejected separately before decoding.
func exactObject(data []byte, required, optional []string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, ErrConflict
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
		if _, exists := fields[key]; !exists {
			return nil, ErrConflict
		}
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key, value := range fields {
		if !allowed[key] || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, ErrConflict
		}
	}
	return fields, nil
}

func uniqueJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 16 {
			return ErrConflict
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, container := token.(json.Delim)
		if !container {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[name] {
					return ErrConflict
				}
				seen[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return ErrConflict
		}
		_, err = decoder.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return ErrConflict
	}
	return nil
}

func validRequestID(id string) bool {
	if len(id) < 1 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func validateTransportPayload(request transportRequest) (probePayload, effectPayload, error) {
	var probe probePayload
	var effect effectPayload
	if request.Operation == "probe" {
		if _, err := exactObject(request.Payload, []string{"root", "path"}, nil); err != nil {
			return probe, effect, err
		}
		if err := json.Unmarshal(request.Payload, &probe); err != nil || probe.Root == "" || probe.Path == "" {
			return probe, effect, ErrConflict
		}
		return probe, effect, nil
	}
	fields, err := exactObject(request.Payload, []string{"edit", "journal"}, nil)
	if err != nil {
		return probe, effect, err
	}
	editFields, err := exactObject(fields["edit"], []string{"root", "rootIdentity", "ancestorIdentities", "path", "before", "after", "maxBytes"}, []string{"previousIntentId"})
	if err != nil {
		return probe, effect, err
	}
	// []byte's JSON decoder accepts newlines in base64. The wire contract does
	// not: one canonical encoding avoids multiple representations of an effect.
	for _, key := range []string{"before", "after"} {
		var encoded string
		if err := json.Unmarshal(editFields[key], &encoded); err != nil {
			return probe, effect, err
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded {
			return probe, effect, ErrConflict
		}
	}
	if err := json.Unmarshal(request.Payload, &effect); err != nil || effect.Journal == "" {
		return probe, effect, ErrConflict
	}
	if err := validate(effect.Edit); err != nil {
		return probe, effect, err
	}
	return probe, effect, nil
}

func transportErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrUnsupported):
		return "FILE_EFFECT_UNSUPPORTED"
	case errors.Is(err, ErrConflict), errors.Is(err, errImageAncestor):
		return "FILE_EFFECT_CONFLICT"
	case errors.Is(err, os.ErrExist):
		return "FILE_EFFECT_ALREADY_EXISTS"
	case errors.Is(err, os.ErrNotExist):
		return "FILE_EFFECT_NOT_FOUND"
	case runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33))):
		return "FILE_EFFECT_BUSY"
	case errors.Is(err, os.ErrPermission):
		return "FILE_EFFECT_ACCESS_DENIED"
	default:
		return "FILE_EFFECT_IO_ERROR"
	}
}

// RunTransport processes exactly one bounded frame. It never creates a journal
// directory, changes roots, retries an operation implicitly, or exposes the
// internal test phase hook. Core must verify authority and bind paths first.
func RunTransport(reader io.Reader, writer io.Writer) int {
	response := transportResponse{ProtocolVersion: TransportProtocolVersion, Status: "error", AuthorityEffect: "none"}
	responseLimit := int64(4096) // Invalid frames still receive one bounded error.
	emit := func(code string) int {
		exit := 0
		if code != "" {
			response.Status = "error"
			response.Error = &transportError{Code: code}
			exit = 2
		} else {
			response.Status = "ok"
		}
		encoded, err := json.Marshal(response)
		if err != nil || int64(len(encoded)+1) > responseLimit {
			response.Result = nil
			response.Status = "error"
			response.Error = &transportError{Code: "FILE_EFFECT_RESPONSE_LIMIT"}
			encoded, _ = json.Marshal(response)
			exit = 2
		}
		encoded = append(encoded, '\n')
		if n, err := writer.Write(encoded); err != nil || n != len(encoded) {
			return 2
		}
		return exit
	}
	data, err := io.ReadAll(io.LimitReader(reader, TransportMaxBytes+1))
	if err != nil {
		return emit("FILE_EFFECT_INPUT_IO")
	}
	if len(data) > TransportMaxBytes {
		return emit("FILE_EFFECT_REQUEST_LIMIT")
	}
	response.RequestDigest = digest(data)
	if err := uniqueJSON(data); err != nil || !utf8.Valid(data) {
		return emit("FILE_EFFECT_INVALID_REQUEST")
	}
	if _, err := exactObject(data, []string{"protocolVersion", "requestId", "operation", "maxRequestBytes", "maxResponseBytes", "payloadDigest", "payload"}, nil); err != nil {
		return emit("FILE_EFFECT_INVALID_REQUEST")
	}
	var request transportRequest
	if err := json.Unmarshal(data, &request); err != nil || request.ProtocolVersion != TransportProtocolVersion || !validRequestID(request.RequestID) {
		return emit("FILE_EFFECT_INVALID_REQUEST")
	}
	switch request.Operation {
	case "probe", "inspect", "edit", "retry", "image-preflight", "image-apply", "image-inspect", "image-retry":
	default:
		return emit("FILE_EFFECT_INVALID_REQUEST")
	}
	if request.MaxRequestBytes < 1 || request.MaxRequestBytes > TransportMaxBytes || int64(len(data)) > request.MaxRequestBytes {
		return emit("FILE_EFFECT_REQUEST_LIMIT")
	}
	if request.MaxResponseBytes < 4096 || request.MaxResponseBytes > TransportMaxBytes {
		return emit("FILE_EFFECT_RESPONSE_LIMIT")
	}
	decodedDigest, err := hex.DecodeString(request.PayloadDigest)
	if err != nil || len(decodedDigest) != 32 || request.PayloadDigest != digest(request.Payload) {
		return emit("FILE_EFFECT_PAYLOAD_DIGEST")
	}
	response.RequestID, response.Operation, response.PayloadDigest = request.RequestID, request.Operation, request.PayloadDigest
	responseLimit = request.MaxResponseBytes
	if strings.HasPrefix(request.Operation, "image-") {
		payload, parseErr := validateImageTransportPayload(request)
		if parseErr != nil {
			return emit("FILE_EFFECT_INVALID_PAYLOAD")
		}
		if request.Operation == "image-preflight" && int64(2048+128*(strings.Count(payload.Effect.Path, "/")+1)) > responseLimit {
			return emit("FILE_EFFECT_RESPONSE_LIMIT")
		}
		switch request.Operation {
		case "image-preflight":
			result, operationErr := PreflightImageEffect(payload.Effect, payload.Journal)
			err = operationErr
			if err == nil {
				response.Result = result
			}
		case "image-apply":
			result, operationErr := ApplyImageEffect(payload.Effect, payload.Journal, nil)
			response.Result, err = result, operationErr
		case "image-inspect":
			result, operationErr := InspectImageEffect(payload.Effect, payload.Journal)
			response.Result, err = result, operationErr
		case "image-retry":
			result, operationErr := RetryKnownNoImageEffect(payload.Effect, payload.Journal, nil)
			response.Result, err = result, operationErr
		}
		if err != nil {
			return emit(transportErrorCode(err))
		}
		return emit("")
	}
	probe, effect, err := validateTransportPayload(request)
	if err != nil {
		return emit("FILE_EFFECT_INVALID_PAYLOAD")
	}
	// Reserve output before any mutation. Fixed-size outcomes/inspections fit
	// 4KiB; probe may carry one fixed native identity per affected ancestor.
	if request.Operation == "probe" && int64(2048+128*(strings.Count(probe.Path, "/")+1)) > responseLimit {
		return emit("FILE_EFFECT_RESPONSE_LIMIT")
	}
	if runtime.GOOS != "windows" {
		return emit("FILE_EFFECT_UNSUPPORTED")
	}
	switch request.Operation {
	case "probe":
		identities, operationErr := ProbeAncestorIdentities(probe.Root, probe.Path)
		err = operationErr
		if err == nil {
			response.Result = probeResult{RootIdentity: identities[0], AncestorIdentities: identities}
		}
	case "inspect":
		result, operationErr := InspectExisting(effect.Edit, effect.Journal)
		response.Result, err = result, operationErr
	case "edit":
		result, operationErr := EditExisting(effect.Edit, effect.Journal, nil)
		response.Result, err = result, operationErr
	case "retry":
		result, operationErr := RetryKnownNoWrite(effect.Edit, effect.Journal, nil)
		response.Result, err = result, operationErr
	}
	if err != nil {
		return emit(transportErrorCode(err))
	}
	return emit("")
}
