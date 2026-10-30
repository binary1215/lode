package main

import (
	"encoding/json"
	"os"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/arcadedbbridge"
)

var version = "0.0.0-dev"
var commit = "unknown"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version-json" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"bridgeProtocolVersion": arcadedbbridge.ProtocolVersion,
			"commit":                commit,
			"version":               version,
		})
		return
	}
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	os.Exit(arcadedbbridge.Run(os.Stdin, os.Stdout, nil))
}
