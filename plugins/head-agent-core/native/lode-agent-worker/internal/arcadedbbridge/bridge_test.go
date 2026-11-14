package arcadedbbridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type faultTransport func(*http.Request) (*http.Response, error)

func TestBridgeAcceptsOnlyExactLegacyOrLodeProtocol(t *testing.T) {
	value := request{
		Protocol: protocol{Name: ProtocolName, Version: ProtocolVersion},
		Endpoint: "https://synthetic.invalid", Database: "fixture", Operation: "query-batch", TimeoutMS: 1000,
		SecretReferenceNames: secretReferenceNames{Username: "SYNTHETIC_USER", Password: "SYNTHETIC_PASSWORD"},
		Queries: []query{{Language: "sql", Command: "SELECT 1"}},
	}
	for _, name := range []string{ProtocolName, LodeProtocolName} {
		value.Protocol.Name = name
		if err := validate(value); err != nil {
			t.Fatalf("recognized protocol %s rejected: %v", name, err)
		}
	}
	for _, name := range []string{"lode-agent-core-arcadedb-query-batch-unknown", "head-agent-core-arcadedb-query-batch-unknown"} {
		value.Protocol.Name = name
		if err := validate(value); err == nil {
			t.Fatalf("unknown protocol %s accepted", name)
		}
	}
	value.Protocol = protocol{Name: LodeProtocolName, Version: "0.2.0"}
	if err := validate(value); err == nil {
		t.Fatal("unsupported protocol version accepted")
	}
}

func (f faultTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (brokenBody) Close() error             { return nil }

type closeFaultBody struct{ io.Reader }

func (closeFaultBody) Close() error { return errors.New("synthetic close failure") }

func TestBodyFailuresAreStructuredAndNotMalformedSuccess(t *testing.T) {
	t.Setenv("HEAD_TEST_BODY_USER", "synthetic")
	t.Setenv("HEAD_TEST_BODY_PASSWORD", "synthetic")
	input := `{"protocol":{"name":"head-agent-core-arcadedb-query-batch","version":"0.1.0"},"endpoint":"https://synthetic.invalid","database":"fixture","operation":"query-batch","timeoutMs":1000,"secretReferenceNames":{"username":"HEAD_TEST_BODY_USER","password":"HEAD_TEST_BODY_PASSWORD"},"queries":[{"language":"sql","command":"SELECT 1","params":{}}]}`
	for _, item := range []struct {
		name   string
		body   io.ReadCloser
		status int
		code   string
		exit   int
	}{
		{"reset", brokenBody{}, 200, "ARCADEDB_TRANSPORT_UNAVAILABLE", 2},
		{"close", closeFaultBody{strings.NewReader(`{"result":[]}`)}, 200, "ARCADEDB_TRANSPORT_UNAVAILABLE", 2},
		{"auth", brokenBody{}, 401, "ARCADEDB_AUTHENTICATION_FAILED", 1},
		{"malformed", io.NopCloser(strings.NewReader("not JSON")), 200, "ARCADEDB_REMOTE_RESPONSE_INVALID", 1},
		{"empty", io.NopCloser(strings.NewReader("")), 200, "ARCADEDB_REMOTE_RESPONSE_INVALID", 1},
	} {
		t.Run(item.name, func(t *testing.T) {
			closed := &http.Client{Transport: faultTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: item.status, Body: item.body, Header: make(http.Header)}, nil
			})}
			var output bytes.Buffer
			if exit := Run(strings.NewReader(input), &output, closed); exit != item.exit {
				t.Fatalf("exit=%d output=%s", exit, output.String())
			}
			var answer response
			if err := json.Unmarshal(output.Bytes(), &answer); err != nil || answer.OK || answer.Error == nil || answer.Error.Code != item.code {
				t.Fatalf("invalid failure: %v %s", err, output.String())
			}
		})
	}
}

func TestRunExecutesBoundedQueryBatchWithoutReturningCredentials(t *testing.T) {
	const usernameEnvironment = "HEAD_TEST_ARCADEDB_USERNAME"
	const passwordEnvironment = "HEAD_TEST_ARCADEDB_PASSWORD"
	t.Setenv(usernameEnvironment, "reader")
	t.Setenv(passwordEnvironment, "secret-value")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path != "/api/v1/query/head-test" {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		username, password, ok := request.BasicAuth()
		if !ok || username != "reader" || password != "secret-value" {
			t.Fatal("basic authentication did not use the referenced environment values")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":[{"call":` + string(rune('0'+calls)) + `}]}`))
	}))
	defer server.Close()

	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": server.URL, "database": "head-test", "operation": "query-batch", "timeoutMs": 5000,
		"secretReferenceNames": map[string]any{"username": usernameEnvironment, "password": passwordEnvironment},
		"queries": []any{
			map[string]any{"language": "sql", "command": "SELECT 1", "params": map[string]any{}},
			map[string]any{"language": "sql", "command": "SELECT 2", "params": map[string]any{"value": 2}},
		},
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if exitCode := Run(bytes.NewReader(encoded), &output, server.Client()); exitCode != 0 {
		t.Fatalf("unexpected exit code %d: %s", exitCode, output.String())
	}
	if calls != 2 || bytes.Contains(output.Bytes(), []byte("secret-value")) {
		t.Fatalf("unexpected calls or credential disclosure: calls=%d output=%s", calls, output.String())
	}
	var answer response
	if err := json.Unmarshal(output.Bytes(), &answer); err != nil || !answer.OK || answer.Status != 200 {
		t.Fatalf("invalid response: %v %#v", err, answer)
	}
}

func TestRunRejectsUnavailableCredentialReferences(t *testing.T) {
	const missingUsername = "HEAD_TEST_MISSING_ARCADEDB_USERNAME"
	const missingPassword = "HEAD_TEST_MISSING_ARCADEDB_PASSWORD"
	_ = os.Unsetenv(missingUsername)
	_ = os.Unsetenv(missingPassword)
	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": "http://127.0.0.1:1", "database": "head-test", "operation": "query-batch", "timeoutMs": 1000,
		"secretReferenceNames": map[string]any{"username": missingUsername, "password": missingPassword},
		"queries":              []any{map[string]any{"language": "sql", "command": "SELECT 1", "params": map[string]any{}}},
	}
	encoded, _ := json.Marshal(input)
	var output bytes.Buffer
	if exitCode := Run(bytes.NewReader(encoded), &output, nil); exitCode != 2 {
		t.Fatalf("expected credential exit code 2, got %d: %s", exitCode, output.String())
	}
	if !bytes.Contains(output.Bytes(), []byte("ARCADEDB_CREDENTIALS_UNAVAILABLE")) {
		t.Fatalf("missing credential error: %s", output.String())
	}
}

func TestRunRejectsCommandTextInQueryBatch(t *testing.T) {
	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": "http://127.0.0.1:1", "database": "head-test", "operation": "query-batch", "timeoutMs": 1000,
		"secretReferenceNames": map[string]any{"username": "HEAD_TEST_USERNAME", "password": "HEAD_TEST_PASSWORD"},
		"queries":              []any{map[string]any{"language": "sql", "command": "DELETE FROM HeadAgentGraphNode", "params": map[string]any{}}},
	}
	encoded, _ := json.Marshal(input)
	var output bytes.Buffer
	if exitCode := Run(bytes.NewReader(encoded), &output, nil); exitCode != 1 {
		t.Fatalf("expected invalid-input exit code 1, got %d: %s", exitCode, output.String())
	}
	if !bytes.Contains(output.Bytes(), []byte("ARCADEDB_BRIDGE_INVALID_INPUT")) {
		t.Fatalf("missing invalid-input error: %s", output.String())
	}
}

func TestRunRejectsRedirectWithoutContactingRedirectTarget(t *testing.T) {
	const usernameEnvironment = "HEAD_TEST_REDIRECT_USERNAME"
	const passwordEnvironment = "HEAD_TEST_REDIRECT_PASSWORD"
	t.Setenv(usernameEnvironment, "reader")
	t.Setenv(passwordEnvironment, "secret")
	targetCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		targetCalls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":[]}`))
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/api/v1/query/head-test", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": redirect.URL, "database": "head-test", "operation": "query-batch", "timeoutMs": 1000,
		"secretReferenceNames": map[string]any{"username": usernameEnvironment, "password": passwordEnvironment},
		"queries":              []any{map[string]any{"language": "sql", "command": "SELECT 1", "params": map[string]any{}}},
	}
	encoded, _ := json.Marshal(input)
	var output bytes.Buffer
	if exitCode := Run(bytes.NewReader(encoded), &output, redirect.Client()); exitCode != 3 {
		t.Fatalf("expected rejected redirect exit code 3, got %d: %s", exitCode, output.String())
	}
	if targetCalls != 0 {
		t.Fatalf("redirect target was contacted %d times", targetCalls)
	}
}

func TestRunAppliesOneDeadlineToTheWholeBatch(t *testing.T) {
	const usernameEnvironment = "HEAD_TEST_DEADLINE_USERNAME"
	const passwordEnvironment = "HEAD_TEST_DEADLINE_PASSWORD"
	t.Setenv(usernameEnvironment, "reader")
	t.Setenv(passwordEnvironment, "secret")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		time.Sleep(700 * time.Millisecond)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":[]}`))
	}))
	defer server.Close()
	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": server.URL, "database": "head-test", "operation": "query-batch", "timeoutMs": 1000,
		"secretReferenceNames": map[string]any{"username": usernameEnvironment, "password": passwordEnvironment},
		"queries": []any{
			map[string]any{"language": "sql", "command": "SELECT 1", "params": map[string]any{}},
			map[string]any{"language": "sql", "command": "SELECT 2", "params": map[string]any{}},
		},
	}
	encoded, _ := json.Marshal(input)
	var output bytes.Buffer
	started := time.Now()
	if exitCode := Run(bytes.NewReader(encoded), &output, server.Client()); exitCode != 2 {
		t.Fatalf("expected deadline exit code 2, got %d: %s", exitCode, output.String())
	}
	if time.Since(started) > 1400*time.Millisecond {
		t.Fatalf("batch exceeded its single deadline: %s", time.Since(started))
	}
}

func TestRunBoundsAggregateBatchResponse(t *testing.T) {
	const usernameEnvironment = "HEAD_TEST_LIMIT_USERNAME"
	const passwordEnvironment = "HEAD_TEST_LIMIT_PASSWORD"
	t.Setenv(usernameEnvironment, "reader")
	t.Setenv(passwordEnvironment, "secret")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":[{"value":"` + strings.Repeat("x", 600) + `"}]}`))
	}))
	defer server.Close()
	input := map[string]any{
		"protocol": map[string]any{"name": ProtocolName, "version": ProtocolVersion},
		"endpoint": server.URL, "database": "head-test", "operation": "query-batch", "timeoutMs": 1000,
		"secretReferenceNames": map[string]any{"username": usernameEnvironment, "password": passwordEnvironment},
		"queries": []any{
			map[string]any{"language": "sql", "command": "SELECT 1", "params": map[string]any{}},
			map[string]any{"language": "sql", "command": "SELECT 2", "params": map[string]any{}},
		},
	}
	encoded, _ := json.Marshal(input)
	var output bytes.Buffer
	if exitCode := runWithWireLimit(bytes.NewReader(encoded), &output, server.Client(), 1024); exitCode != 1 {
		t.Fatalf("expected aggregate response limit exit code 1, got %d: %s", exitCode, output.String())
	}
	if !bytes.Contains(output.Bytes(), []byte("ARCADEDB_REQUEST_FAILED")) {
		t.Fatalf("missing aggregate-limit error: %s", output.String())
	}
}
