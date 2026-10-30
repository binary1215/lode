package worker

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func healthRequest(t *testing.T) request {
	t.Helper()
	input := map[string]any{"probe": "head-agent-core"}
	canonicalInput, err := canonicalJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	value := request{
		SchemaVersion:    1,
		Protocol:         protocol{Name: ProtocolName, Version: ProtocolVersion},
		Kind:             "ComputeRequest",
		Operation:        HealthOperation,
		InputDigest:      digest(canonicalInput),
		SemanticProducer: semanticProducer{Name: HealthProducer, Version: HealthVersion},
		Limits: limits{
			TimeoutMS: 30000, MaxInputBytes: 16 * 1024 * 1024, MaxOutputBytes: 32 * 1024 * 1024,
			MaxFiles: 20000, MaxFileBytes: 512 * 1024, MaxTotalBytes: 256 * 1024 * 1024,
		},
		Input:           canonicalInput,
		AuthorityEffect: "none",
	}
	identity := map[string]any{
		"inputDigest": value.InputDigest, "kind": "ComputeRequest", "limits": value.Limits,
		"operation": value.Operation, "protocol": value.Protocol, "schemaVersion": 1,
		"semanticProducer": value.SemanticProducer,
	}
	canonicalIdentity, err := canonicalJSON(identity)
	if err != nil {
		t.Fatal(err)
	}
	value.RequestID = "compute-request-" + digest(canonicalIdentity)[:24]
	return value
}

func TestHealthProducesAuthorityFreeDeterministicResponse(t *testing.T) {
	value := healthRequest(t)
	encoded, err := canonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := Run(bytes.NewReader(encoded), &output); err != nil {
		t.Fatal(err)
	}
	var answer response
	if err := json.Unmarshal(output.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Status != "ok" || answer.RequestID != value.RequestID || answer.ResultDigest == "" {
		t.Fatalf("unexpected response: %+v", answer)
	}
	result, ok := answer.Result.(map[string]any)
	if !ok || result["status"] != "ready" || result["instructionAuthority"] != false || result["promotionAuthority"] != false {
		t.Fatalf("unexpected health result: %#v", answer.Result)
	}
}

func TestRejectsTamperedInputDigest(t *testing.T) {
	value := healthRequest(t)
	value.InputDigest = strings.Repeat("f", 64)
	encoded, err := canonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := Run(bytes.NewReader(encoded), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "input digest") {
		t.Fatalf("expected digest rejection, got %v", err)
	}
}

func TestOutputCeiling512KeepsInput64AndCompleteProtocol(t *testing.T) {
	for _, size := range []int{64, 128, 256, 512} {
		value := healthRequest(t)
		value.Limits.MaxOutputBytes = size * 1024 * 1024
		value = resealRequest(t, value)
		encoded, _ := canonicalJSON(value)
		var output bytes.Buffer
		if err := Run(bytes.NewReader(encoded), &output); err != nil {
			t.Fatalf("output budget %dMiB: %v", size, err)
		}
		var answer response
		if err := json.Unmarshal(output.Bytes(), &answer); err != nil || answer.Status != "ok" || answer.RequestID != value.RequestID {
			t.Fatalf("invalid response at %dMiB: %v", size, err)
		}
	}
	for _, change := range []func(*request){
		func(value *request) { value.Limits.MaxOutputBytes = 512*1024*1024 + 1 },
		func(value *request) { value.Limits.MaxInputBytes = 64*1024*1024 + 1 },
	} {
		value := healthRequest(t)
		change(&value)
		if err := validateRequest(resealRequest(t, value)); err == nil || !strings.Contains(err.Error(), "limits") {
			t.Fatalf("expected independent limit rejection: %v", err)
		}
	}
}

func TestOutputOverflowEmitsTypedBoundedFailureNotCrashOrPartialResult(t *testing.T) {
	value := healthRequest(t)
	value.Limits.MaxOutputBytes = 2048
	value = resealRequest(t, value)
	for _, text := range []string{strings.Repeat("x", 1800), strings.Repeat("가", 700)} {
		answer, err := success(value, map[string]any{"payload": text})
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := encodeResponse(value, answer)
		if err != nil || len(encoded) > value.Limits.MaxOutputBytes {
			t.Fatalf("bounded typed response: %v", err)
		}
		var actual response
		if err := json.Unmarshal(encoded, &actual); err != nil {
			t.Fatal(err)
		}
		if actual.Status != "error" || actual.Result != nil || actual.ResultDigest != "" || actual.RequestID != value.RequestID || len(actual.Errors) != 1 || actual.Errors[0].Code != "COMPUTE_OUTPUT_LIMIT" {
			t.Fatalf("overflow was not a complete typed failure: %+v", actual)
		}
	}
	answer := failure(value, "PERMISSION_DENIED", strings.Repeat("x", 3000))
	if _, err := encodeResponse(value, answer); err == nil {
		t.Fatal("a large non-output failure must not be laundered into a retryable output error")
	}
}

func resealRequest(t *testing.T, value request) request {
	t.Helper()
	canonicalInput, err := canonicalJSON(value.Input)
	if err != nil {
		t.Fatal(err)
	}
	value.InputDigest = digest(canonicalInput)
	identity := map[string]any{
		"inputDigest": value.InputDigest, "kind": "ComputeRequest", "limits": value.Limits,
		"operation": value.Operation, "protocol": value.Protocol, "schemaVersion": 1,
		"semanticProducer": value.SemanticProducer,
	}
	canonicalIdentity, err := canonicalJSON(identity)
	if err != nil {
		t.Fatal(err)
	}
	value.RequestID = "compute-request-" + digest(canonicalIdentity)[:24]
	return value
}

func TestHealthAcceptsOnlyCoherentOriginalFamilies(t *testing.T) {
	for _, item := range []struct {
		name     string
		protocol string
		producer string
		probe    string
		status   string
	}{
		{"legacy", ProtocolName, HealthProducer, "head-agent-core", "ok"},
		{"lode", LodeProtocolName, LodeHealthProducer, "lode-agent-core", "ok"},
		{"legacy-new-producer", ProtocolName, LodeHealthProducer, "head-agent-core", "error"},
		{"new-legacy-producer", LodeProtocolName, HealthProducer, "lode-agent-core", "error"},
		{"legacy-new-probe", ProtocolName, HealthProducer, "lode-agent-core", "error"},
		{"new-legacy-probe", LodeProtocolName, LodeHealthProducer, "head-agent-core", "error"},
	} {
		t.Run(item.name, func(t *testing.T) {
			value := healthRequest(t)
			value.Protocol.Name = item.protocol
			value.SemanticProducer.Name = item.producer
			value.Input, _ = canonicalJSON(map[string]any{"probe": item.probe})
			value = resealRequest(t, value)
			answer, err := handle(value)
			if err != nil || answer.Status != item.status || answer.Protocol != value.Protocol || answer.RequestID != value.RequestID || answer.InputDigest != value.InputDigest || answer.SemanticProducer != value.SemanticProducer {
				t.Fatalf("family or original correlation changed: err=%v answer=%+v", err, answer)
			}
		})
	}
}

func TestFamilyRenameCannotRepairOriginalRequestIdentity(t *testing.T) {
	value := healthRequest(t)
	value.Protocol.Name = LodeProtocolName
	value.SemanticProducer.Name = LodeHealthProducer
	if _, err := handle(value); err == nil || !strings.Contains(err.Error(), "request ID") {
		t.Fatalf("expected original request identity rejection, got %v", err)
	}
}

func TestScanRejectsHybridBeforeOpeningRepository(t *testing.T) {
	for _, item := range []struct {
		producer string
		scope    string
		code     string
	}{
		{"head-agent-core-repository-scan", "lode-agent-core-repository-source-scope", "REPOSITORY_SCAN_PRODUCER_MISMATCH"},
		{"lode-agent-core-repository-scan", "head-agent-core-repository-source-scope", "INVALID_REPOSITORY_SOURCE_SCOPE"},
	} {
		value := healthRequest(t)
		value.Protocol.Name = LodeProtocolName
		value.Operation = "repository.scan.v1"
		value.SemanticProducer = semanticProducer{Name: item.producer, Version: "0.5.1"}
		scope := map[string]any{
			"schemaVersion": 1, "kind": "RepositorySourceScope",
			"protocol":     map[string]any{"name": item.scope, "version": "0.1.0"},
			"includeRoots": []any{}, "excludeRoots": []any{},
			"authority": "user-selected-observation-boundary", "instructionAuthority": false, "promotionAuthority": false,
		}
		canonicalScope, err := canonicalJSON(scope)
		if err != nil {
			t.Fatal(err)
		}
		scopeHash := digest(canonicalScope)
		scope["sourceScopeId"], scope["sourceScopeHash"] = "repository-source-scope-"+scopeHash[:24], scopeHash
		value.Input, _ = canonicalJSON(map[string]any{
			"schemaVersion": 1, "kind": "RepositoryScanInput",
			"projectRoot":      filepath.Join(t.TempDir(), "missing-repository-must-not-be-opened"),
			"managedRootFiles": []string{}, "sourceScope": scope,
		})
		answer, err := handle(resealRequest(t, value))
		if err != nil || answer.Status != "error" || len(answer.Errors) != 1 || answer.Errors[0].Code != item.code {
			t.Fatalf("hybrid input reached scan: err=%v answer=%+v", err, answer)
		}
	}
}

func TestScanKeepsOriginalMalformedInputErrorPriority(t *testing.T) {
	for _, item := range []struct {
		name  string
		input map[string]any
		code  string
	}{
		{"missing-root", map[string]any{}, "INVALID_REPOSITORY_SCAN_INPUT"},
		{"missing-managed-list", map[string]any{"projectRoot": t.TempDir()}, "INVALID_REPOSITORY_SCAN_INPUT"},
		{"missing-scope", map[string]any{"projectRoot": t.TempDir(), "managedRootFiles": []string{}}, "INVALID_REPOSITORY_SCAN_INPUT"},
		{"malformed-scope", map[string]any{"projectRoot": t.TempDir(), "managedRootFiles": []string{}, "sourceScope": "invalid"}, "INVALID_REPOSITORY_SOURCE_SCOPE"},
		{"unexpected-field", map[string]any{"unexpected": true}, "INVALID_REPOSITORY_SCAN_SCHEMA"},
	} {
		t.Run(item.name, func(t *testing.T) {
			value := healthRequest(t)
			value.Protocol.Name = LodeProtocolName
			value.Operation = "repository.scan.v1"
			value.SemanticProducer = semanticProducer{Name: "lode-agent-core-repository-scan", Version: "0.5.1"}
			value.Input, _ = canonicalJSON(item.input)
			answer, err := handle(resealRequest(t, value))
			if err != nil || len(answer.Errors) != 1 || answer.Errors[0].Code != item.code {
				t.Fatalf("original parse order changed: err=%v answer=%+v", err, answer)
			}
		})
	}
}
