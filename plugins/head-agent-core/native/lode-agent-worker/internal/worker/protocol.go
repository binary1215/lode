package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/canonicaljson"
	"github.com/binary1215/lode/native/lode-agent-worker/internal/repositoryscan"
)

const (
	ProtocolName          = "head-agent-core-worker-protocol"
	LodeProtocolName      = "lode-agent-core-worker-protocol"
	ProtocolVersion       = "0.2.0"
	HealthOperation       = "worker.health.v1"
	HealthProducer        = "head-agent-core-worker-health"
	LodeHealthProducer    = "lode-agent-core-worker-health"
	HealthVersion         = "0.1.0"
	LifecycleOperation    = "worker.lifecycle.v1"
	LifecycleProducer     = "head-agent-core-worker-lifecycle"
	LodeLifecycleProducer = "lode-agent-core-worker-lifecycle"
	LifecycleVersion      = "0.1.0"
	maximumWireBytes      = 65 * 1024 * 1024
)

var (
	requestIDPattern = regexp.MustCompile(`^compute-request-[a-f0-9]{24}$`)
	digestPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type protocol struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type semanticProducer struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type limits struct {
	TimeoutMS      int `json:"timeoutMs"`
	MaxInputBytes  int `json:"maxInputBytes"`
	MaxOutputBytes int `json:"maxOutputBytes"`
	MaxFiles       int `json:"maxFiles"`
	MaxFileBytes   int `json:"maxFileBytes"`
	MaxTotalBytes  int `json:"maxTotalBytes"`
}

type request struct {
	SchemaVersion    int              `json:"schemaVersion"`
	Protocol         protocol         `json:"protocol"`
	Kind             string           `json:"kind"`
	RequestID        string           `json:"requestId"`
	Operation        string           `json:"operation"`
	InputDigest      string           `json:"inputDigest"`
	SemanticProducer semanticProducer `json:"semanticProducer"`
	Limits           limits           `json:"limits"`
	Input            json.RawMessage  `json:"input"`
	AuthorityEffect  string           `json:"authorityEffect"`
}

type message struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	SchemaVersion    int              `json:"schemaVersion"`
	Protocol         protocol         `json:"protocol"`
	Kind             string           `json:"kind"`
	RequestID        string           `json:"requestId"`
	Operation        string           `json:"operation"`
	InputDigest      string           `json:"inputDigest"`
	SemanticProducer semanticProducer `json:"semanticProducer"`
	AuthorityEffect  string           `json:"authorityEffect"`
	Status           string           `json:"status"`
	Result           any              `json:"result"`
	ResultDigest     string           `json:"resultDigest"`
	Warnings         []message        `json:"warnings"`
	Errors           []message        `json:"errors"`
}

func canonicalJSON(value any) ([]byte, error) {
	return canonicaljson.Marshal(value)
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func decodeStrict(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("worker input contains trailing JSON")
	}
	return nil
}

func validateRequest(value request) error {
	if value.SchemaVersion != 1 || value.Kind != "ComputeRequest" || value.AuthorityEffect != "none" {
		return errors.New("worker request envelope is invalid")
	}
	if (value.Protocol.Name != ProtocolName && value.Protocol.Name != LodeProtocolName) || value.Protocol.Version != ProtocolVersion {
		return errors.New("worker protocol version is incompatible")
	}
	if !requestIDPattern.MatchString(value.RequestID) || !digestPattern.MatchString(value.InputDigest) {
		return errors.New("worker request identity is invalid")
	}
	var input any
	if err := json.Unmarshal(value.Input, &input); err != nil {
		return errors.New("worker request input is invalid JSON")
	}
	canonicalInput, err := canonicalJSON(input)
	if err != nil || digest(canonicalInput) != value.InputDigest {
		return errors.New("worker request input digest does not match")
	}
	if len(canonicalInput) > value.Limits.MaxInputBytes {
		return errors.New("worker request input exceeds maxInputBytes")
	}
	identity := map[string]any{
		"inputDigest":      value.InputDigest,
		"kind":             "ComputeRequest",
		"limits":           value.Limits,
		"operation":        value.Operation,
		"protocol":         value.Protocol,
		"schemaVersion":    1,
		"semanticProducer": value.SemanticProducer,
	}
	canonicalIdentity, err := canonicalJSON(identity)
	if err != nil {
		return err
	}
	expectedRequestID := "compute-request-" + digest(canonicalIdentity)[:24]
	if value.RequestID != expectedRequestID {
		return errors.New("worker request ID does not match")
	}
	if value.Limits.TimeoutMS < 10 || value.Limits.TimeoutMS > 300000 ||
		value.Limits.MaxInputBytes < 2 || value.Limits.MaxInputBytes > 64*1024*1024 ||
		value.Limits.MaxOutputBytes < 2048 || value.Limits.MaxOutputBytes > 512*1024*1024 ||
		value.Limits.MaxFiles < 1 || value.Limits.MaxFiles > 100000 ||
		value.Limits.MaxFileBytes < 1 || value.Limits.MaxFileBytes > 16*1024*1024 ||
		value.Limits.MaxTotalBytes < 1 || value.Limits.MaxTotalBytes > 1024*1024*1024 {
		return errors.New("worker request limits are invalid")
	}
	return nil
}

func envelope(value request) response {
	return response{
		SchemaVersion:    1,
		Protocol:         value.Protocol,
		Kind:             "ComputeResponse",
		RequestID:        value.RequestID,
		Operation:        value.Operation,
		InputDigest:      value.InputDigest,
		SemanticProducer: value.SemanticProducer,
		AuthorityEffect:  "none",
		Warnings:         []message{},
		Errors:           []message{},
	}
}

func success(value request, result any) (response, error) {
	canonicalResult, err := canonicalJSON(result)
	if err != nil {
		return response{}, err
	}
	if len(canonicalResult) > value.Limits.MaxOutputBytes {
		return failure(value, "COMPUTE_OUTPUT_LIMIT", "Compute result exceeds maxOutputBytes."), nil
	}
	answer := envelope(value)
	answer.Status = "ok"
	answer.Result = result
	answer.ResultDigest = digest(canonicalResult)
	return answer, nil
}

func failure(value request, code string, text string) response {
	answer := envelope(value)
	answer.Status = "error"
	answer.Result = nil
	answer.ResultDigest = ""
	answer.Errors = []message{{Code: code, Message: text}}
	return answer
}

func health(value request) (response, error) {
	producer, expectedProbe := HealthProducer, "head-agent-core"
	if value.Protocol.Name == LodeProtocolName {
		producer, expectedProbe = LodeHealthProducer, "lode-agent-core"
	}
	if value.SemanticProducer.Name != producer || value.SemanticProducer.Version != HealthVersion {
		return failure(value, "WORKER_HEALTH_PRODUCER_MISMATCH", "Worker health semantic producer is incompatible."), nil
	}
	var input map[string]json.RawMessage
	if err := decodeStrict(value.Input, &input); err != nil || len(input) != 1 {
		return failure(value, "INVALID_WORKER_HEALTH_INPUT", "Worker health input is invalid."), nil
	}
	var probe string
	if err := json.Unmarshal(input["probe"], &probe); err != nil || probe != expectedProbe {
		return failure(value, "INVALID_WORKER_HEALTH_INPUT", "Worker health input is invalid."), nil
	}
	return success(value, map[string]any{
		"controlAuthority":     false,
		"instructionAuthority": false,
		"kind":                 "WorkerHealthResult",
		"promotionAuthority":   false,
		"status":               "ready",
	})
}

func lifecycle(value request) (response, error) {
	producer := LifecycleProducer
	if value.Protocol.Name == LodeProtocolName {
		producer = LodeLifecycleProducer
	}
	if value.SemanticProducer.Name != producer || value.SemanticProducer.Version != LifecycleVersion {
		return failure(value, "WORKER_LIFECYCLE_PRODUCER_MISMATCH", "Worker lifecycle semantic producer is incompatible."), nil
	}
	var input map[string]json.RawMessage
	if err := decodeStrict(value.Input, &input); err != nil || len(input) != 1 {
		return failure(value, "INVALID_WORKER_LIFECYCLE_INPUT", "Worker lifecycle input is invalid."), nil
	}
	var mode string
	if err := json.Unmarshal(input["mode"], &mode); err != nil || mode != "wait-for-cancellation" {
		return failure(value, "INVALID_WORKER_LIFECYCLE_INPUT", "Worker lifecycle input is invalid."), nil
	}
	time.Sleep(60 * time.Second)
	return success(value, map[string]any{
		"controlAuthority":     false,
		"instructionAuthority": false,
		"kind":                 "WorkerLifecycleResult",
		"promotionAuthority":   false,
		"status":               "completed-without-cancellation",
	})
}

func handle(value request) (response, error) {
	if err := validateRequest(value); err != nil {
		return response{}, err
	}
	if value.Operation == HealthOperation {
		return health(value)
	}
	if value.Operation == LifecycleOperation {
		return lifecycle(value)
	}
	if value.Operation == repositoryscan.Operation {
		producer := repositoryscan.ProducerName
		if value.Protocol.Name == LodeProtocolName {
			producer = repositoryscan.LodeProducerName
		}
		if value.SemanticProducer.Name != producer || value.SemanticProducer.Version != repositoryscan.ProducerVersion {
			return failure(value, "REPOSITORY_SCAN_PRODUCER_MISMATCH", "Repository scan semantic producer is incompatible."), nil
		}
		result, operationFailure := repositoryscan.Scan(value.Input, repositoryscan.Limits{
			MaxFiles: value.Limits.MaxFiles, MaxFileBytes: value.Limits.MaxFileBytes, MaxTotalBytes: value.Limits.MaxTotalBytes,
			ExpectedProducer: value.SemanticProducer.Name,
		})
		if operationFailure != nil {
			return failure(value, operationFailure.Code, operationFailure.Message), nil
		}
		return success(value, result)
	}
	return failure(value, "UNSUPPORTED_COMPUTE_OPERATION", fmt.Sprintf("Unsupported compute operation: %s", value.Operation)), nil
}

func encodeResponse(value request, answer response) ([]byte, error) {
	encoded, err := canonicalJSON(answer)
	if err != nil {
		return nil, fmt.Errorf("encode worker response: %w", err)
	}
	if len(encoded) > value.Limits.MaxOutputBytes {
		if answer.Status != "ok" {
			return nil, errors.New("worker error response exceeds request output limit")
		}
		// Typed, bounded failure is distinct from a crash/stdout protocol breach.
		encoded, err = canonicalJSON(failure(value, "COMPUTE_OUTPUT_LIMIT", "Compute response exceeds maxOutputBytes."))
		if err != nil || len(encoded) > value.Limits.MaxOutputBytes {
			return nil, errors.New("worker output-limit response exceeds request output limit")
		}
	}
	return encoded, nil
}

// Run processes exactly one bounded request and emits exactly one response.
// The worker never spawns descendants, writes project state, or opens network connections.
func Run(input io.Reader, output io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(input, maximumWireBytes+1))
	if err != nil {
		return fmt.Errorf("read worker request: %w", err)
	}
	if len(data) > maximumWireBytes {
		return errors.New("worker request exceeds hard input limit")
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("worker request is empty")
	}
	var value request
	if err := decodeStrict(data, &value); err != nil {
		return fmt.Errorf("decode worker request: %w", err)
	}
	answer, err := handle(value)
	if err != nil {
		return err
	}
	encoded, err := encodeResponse(value, answer)
	if err != nil {
		return fmt.Errorf("encode worker response: %w", err)
	}
	if _, err := output.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write worker response: %w", err)
	}
	return nil
}
